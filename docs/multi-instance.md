# Multi-instance — 12.5

O backend roda em duas topologias. PostgreSQL é o único sistema de
coordenação: não há Redis, broker nem roteamento sticky. Toda regra de
segurança ou de correção é decidida por linhas e locks do banco; a memória de
cada processo é só o handle físico dos sockets que ele segura.

Código: `src/cluster/`, `src/lifecycle/`, `src/game-bridge/game-connection.service.ts`,
`src/game-agent/agent.gateway.ts`, `src/realtime/realtime.gateway.ts`.
Migration: `1790060000000-MultiInstance` (27ª, forward-only).
Testes: `test/multi-instance.e2e-spec.ts` (réplicas reais sobre um PostgreSQL,
sem mock de coordenação), `src/cluster/cluster.spec.ts`.

## 1. SINGLE × MULTI

| | SINGLE (padrão) | MULTI |
| --- | --- | --- |
| Réplicas | 1 | N simultâneas atrás de um load balancer |
| Lock global | `pg_advisory_lock(1397446994, 1)` obrigatório em produção; segunda instância recusada (12.2) | nunca adquirido; `SINGLE_INSTANCE_LOCK_ENABLED=true` com MULTI falha no boot |
| Startup | fecha todas as sessões de Agent (`BACKEND_RESTART`) | fecha só sessões com lease vencida ou sem dono (`STALE`) |
| Rate limits | memória do processo | PostgreSQL (`rate_limit_buckets`), cluster-wide |
| Cap de conexões por conta | contagem do registry local | leases no banco, cluster-wide |
| Realtime | fan-out em processo | fan-out local + bus LISTEN/NOTIFY |
| Deploy | recreate | réplicas simultâneas; **rolling de versões não está liberado** (§12) |

Não existe fallback silencioso: `BACKEND_TOPOLOGY` só aceita `SINGLE` ou `MULTI`.

## 2. Identidade de instância

`InstanceIdentity.id` é um UUID aleatório gerado no boot, nunca reaproveitado
depois de um restart e nunca derivado do hostname. É a identidade de
ownership (Agent) e de leases (realtime). Aparece nos logs (`Instance
starting/stopping [instanceId=…]`, logs de Agent); nunca é label de métrica.

## 3. Agent: ownership, lease e fencing

- O socket físico de um Agent vive em uma instância. O HELLO grava
  `game_connections.owner_instance_id` = a instância que aceitou o socket, na
  mesma transação (lock de `game_servers`) que fecha a sessão anterior como
  SUPERSEDED.
- **Lease = frescor do heartbeat**: `last_heartbeat_at + GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS`.
  Só o dono renova (o heartbeat exige `owner_instance_id` = instância local).
  Não há segundo relógio a divergir.
- **Autoridade**: uma instância só age por uma sessão que o banco diz ser a
  CONNECTED do servidor, dela, com lease válida e credencial ACTIVE:
  - envio de COMMAND: o reserve verifica o dono sob o lock do servidor, antes
    de consumir tentativa;
  - envio de SERVER_CONTROL: o próprio UPDATE do claim exige o dono;
  - push de work: cada instância só itera suas sessões locais;
  - frames recebidos: ACK/RESULT (sob o lock do servidor), SERVER_CONTROL_RESULT,
    DOMAIN_EVENT (antes e dentro da transação de domínio, com `FOR SHARE` na
    conexão), WORK_SYNC, heartbeat e runtime (UPDATE condicional).
- O registry local nunca é autoridade: um socket que ainda existe em memória
  mas perdeu a sessão no banco tem todo frame recusado e é fechado
  (`SESSION_CLOSED`).

### Supersede e revogação entre instâncias

1. HELLO novo em B: transação fecha a sessão de A como SUPERSEDED e cria a de B.
2. Depois do commit, B publica `AGENT_SESSION_CLOSED`; A fecha o socket antigo.
3. Revogação de credencial em qualquer instância: fecha as linhas no banco,
   publica `AGENT_CREDENTIAL_REVOKED`, cada instância fecha seus sockets.

Se o sinal se perder, o socket antigo continua aberto, mas o banco já não o
reconhece: DOMAIN_EVENT, RESULT e heartbeat são recusados e o socket é fechado
no primeiro frame (provado com NOTIFY suprimido).

### Stale e startup

- Sweep DB-only em MULTI (a cada ~5 s, qualquer réplica): fecha como STALE
  sessões cujo heartbeat expirou, uma transição condicional sob o lock do
  servidor; um dono vivo renovando nunca é tocado.
- O sweep local fecha sockets locais pelo último heartbeat renovado **no banco**:
  sem banco não há renovação e o socket cai no timeout local.
- Startup em MULTI nunca fecha sessões de outras instâncias só porque não
  estão no registry local (`endAllActive` é só de SINGLE).

## 4. GameCommand (at-least-once) e Server Control (at-most-once)

- HTTP pode criar a operação em qualquer instância; o banco é a fila.
- **GameCommand**: workers rodam em todas as instâncias, mas só o dono da
  sessão reserva. O orçamento `AGENT_MAX_IN_FLIGHT_COMMANDS` é contado dentro
  do reserve, sob o lock do servidor (corrige o achado da 12.0). Failover:
  - antes do envio: o command fica PENDING sem tentativa consumida e o novo
    dono o envia como tentativa 1;
  - depois da entrega: a nova sessão recebe a próxima tentativa com o mesmo
    `commandId`/`correlationId`/payload, e o journal do Agent responde sem
    reexecutar; um RESULT de qualquer sessão ativa e dona é aceito.
- **Server Control**: só o dono cruza o claim (fronteira de entrega). Depois
  do claim ninguém reenvia: um RESULT tardio por outra instância é aceito; sem
  RESULT, a operação termina UNCERTAIN no deadline. Failover nunca vira retry.

## 5. Bus distribuído (LISTEN/NOTIFY)

- Publicar = um statement autocommit: `INSERT` em `distributed_bus_events`
  (envelope, TTL `CLUSTER_BUS_EVENT_TTL_MS`) + `pg_notify(canal, origem:eventId)`.
  O NOTIFY nunca carrega o payload.
- Cada instância escuta numa conexão `pg` **dedicada** (nunca do pool), lê o
  envelope pelo id e entrega só aos sockets locais. A origem não recebe o
  próprio evento. Não há replay: um cliente que reconecta relê por HTTP.
- Perda do LISTEN: log, `cluster_bus_connected 0`, reconexão com backoff de
  250 ms até `CLUSTER_BUS_RECONNECT_MAX_MS`, `cluster_bus_reconnects_total`.
- Limpeza limitada (1000 linhas por vez) a cada `CLUSTER_CLEANUP_INTERVAL_MS`,
  por qualquer réplica, sem eleição de líder.
- Tipos: `REALTIME`, `PLAYER_SESSION_REVOKED`, `PLAYER_ACCOUNT_REVOKED`,
  `AGENT_SESSION_CLOSED`, `AGENT_CREDENTIAL_REVOKED`.

**PgBouncer**: a conexão LISTEN exige conexão direta ou *session pooling*.
Transaction pooling não serve para o listener (LISTEN é estado de sessão). O
pool da aplicação pode continuar em transaction pooling.

### O bus nunca é autoridade

| Sinal perdido | Efeito | Proteção |
| --- | --- | --- |
| Wake-up realtime | cliente não é acordado | HTTP é a fonte de verdade |
| Logout/revogação/ban de Player | socket fica aberto até o próximo evento | antes de cada entrega Player, uma query confere sessão ativa e conta ACTIVE; sessão inválida → socket fechado, evento não entregue |
| Supersede/revogação de Agent | socket antigo fica aberto | fencing no banco em todo frame |
| Mudança de role Staff | — | Staff é reautorizado no banco a cada entrega |

## 6. Realtime entre instâncias

- Mutation em B → publicação local em B + relay pelo bus → A entrega aos
  sockets dele. Entrega é best effort; duplicatas são toleradas.
- Player: autorização por entrega no banco (acima), em lote por evento.
- Staff: `AuthService.authenticate` a cada entrega, como antes.
- **Leases de conexão** (`realtime_connection_leases`): em MULTI o cap
  `REALTIME_MAX_CONNECTIONS_PER_IDENTITY` conta os sockets do principal em
  todas as réplicas (lock consultivo por principal, contagem, insert).
  Renovação em um UPDATE por instância (`REALTIME_LEASE_RENEW_INTERVAL_MS`),
  remoção no close e no shutdown; se a instância morre, as leases expiram em
  `REALTIME_LEASE_TTL_MS` e o cap volta a admitir (provado). Nenhum token é
  gravado. Banco indisponível na admissão → socket recusado (`1013`).

## 7. Rate limits distribuídos

| Cluster-wide (PostgreSQL em MULTI) | Local (recurso do processo) |
| --- | --- |
| login Staff (IP, username), refresh Staff (IP, sessão), auth Player, conexão realtime por IP, HELLO e falhas de auth do Agent, ações caras de Player, ações de operador, chat (`rate_limit_slots`, um slot por Idempotency-Key) | concorrência de Argon2, HELLOs simultâneos, sockets não autenticados, total de sockets, frames por sessão Agent |

- Upsert atômico por `(escopo, SHA-256(escopo + chave))`: IP, username,
  sessão e ids nunca são gravados em texto. Relógio do banco, igual para todas
  as réplicas.
- **Fail closed**: se o banco falha no `consume`, a tentativa é recusada (429)
  e `rate_limit_backend_errors_total` sobe. O bus, ao contrário, **falha
  aberto** em relação ao wake-up: o dado continua correto no banco.

## 8. Falha do banco

- `/ready` 503 (como antes); workers não avançam.
- Frames de Agent que mudam estado dependem do banco: `TEMPORARILY_UNAVAILABLE`
  ou fechamento; o heartbeat não renova e a sessão cai. Nada é decidido pela
  memória.
- O processo continua vivo esperando o banco; em MULTI não há lock cuja perda
  encerre a instância.

## 9. Shutdown em MULTI

readiness 503 → workers drenam → leases realtime da instância removidas →
sessões de Agent **dela** gravadas SHUTDOWN e fechadas (1001) → sockets
realtime fechados → LISTEN encerrado → banco. Sessões de outras instâncias não
são tocadas; as demais réplicas continuam ready. SINGLE mantém a sequência da
12.2 (com o lock).

## 10. Métricas

Sem label de instância (o scraper já tem `instance`/`target`).

| Tipo | Métricas | Agregação no dashboard |
| --- | --- | --- |
| Local | processo, HTTP, `db_pool_*`, `agent_sessions_active` (Agents que a instância possui), `realtime_connections`, `realtime_connection_leases`, `worker_*`, `cluster_bus_*`, `cluster_cleanup_rows_total`, `rate_limit_backend_errors_total`, `agent_ownership_lost_total` | `sum()` entre targets para o total do cluster |
| Snapshot global do banco | `game_commands_backlog`, `game_commands_oldest_age_seconds`, `server_control_operations`, `work_backlog`, `work_oldest_age_seconds`, `vip_deliveries`, `vip_delivery_oldest_open_age_seconds`, `recovery_*` | `max()` entre targets (cada réplica expõe o mesmo valor; `sum()` multiplicaria) |

Counters de evento (`*_total`) são locais: `sum(rate(...))` dá o cluster.

## 11. Migration 27

`game_connections.owner_instance_id` (nulo para linhas anteriores: nunca
recebem envio; o startup/sweep as fecha) e as quatro tabelas efêmeras. O
`down` descarta só estado efêmero. Testado: banco novo → 27 e 26 → 27 com uma
sessão legada preservada, `pending=0`, `synchronize=false`, diff 0/0.

## 12. Deploy

- SINGLE: recreate, como na 12.2.
- MULTI: várias réplicas simultâneas são suportadas pela aplicação.
- **Rolling deploy entre versões não está declarado seguro**: exige schema
  expand/contract, compatibilidade de protocolo com o Agent e convivência de
  binários antigo/novo. Fica para a 12.7. Troca de topologia (SINGLE → MULTI)
  é feita com todas as réplicas paradas.
- Conexões por réplica: `DB_POOL_MAX` + 1 (LISTEN, só MULTI) (+ 1 lock, só SINGLE).
