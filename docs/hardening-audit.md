# Etapa 12.0 — Hardening Audit

Auditoria objetiva do backend no fim da Etapa 11 (merge `ca37166`), feita por
leitura de código, config e testes. Não é pentest. Nenhuma correção foi aplicada
nesta subetapa: todo achado abaixo é estado atual. Paths relativos à raiz do repo.

Base medida em 12.0: Node 24.18.0, NestJS 12.0.1, TypeORM 0.3.31, pg 8.23.0,
ws 8.21.3, jose 6.2.12, argon2 0.45.1, Express 5.2.1; PostgreSQL 16 no compose
(migrations exigem ≥ 13 por `gen_random_uuid()`); 25 migrations, `synchronize` e
`migrationsRun` fixos em `false` (`src/database/database.options.ts:13-14`);
647 testes unitários (3,9 s) e 787 e2e (225 s, serial), zero skips.

Severidade de segurança: CRITICAL / HIGH só com risco concreto demonstrável;
depois MEDIUM, LOW, HARDENING. Prioridade de release: P0 bloqueia qualquer
produção; P1 bloqueia release pública; P2 recomendado antes de escalar; P3
pós-release.

---

## 1. Arquitetura operacional atual

Um processo Node (NestJS + Express 5) atende:

- HTTP `/api/v1/*` Staff (JWT `skyrim-admin-*`), Player (JWT `skyrim-player-*`)
  e o público `/vip-store/offers`, `/health` e `/docs`;
- WebSocket `/api/v1/realtime` (surfaces PLAYER e STAFF, push-only) e
  `/api/v1/agent` (Host Agent, bidirecional), num único roteador de upgrade
  (`src/websocket/websocket-upgrade.router.ts`);
- cinco loops periódicos no próprio processo (§3);
- PostgreSQL como única fonte de verdade persistente. Não há Redis, broker,
  fila nem cache externo.

Todo estado de conexão (sockets, sessões do Agent, destinatários realtime) e
todo rate limit vivem na memória do processo. O desenho da Etapa 11 é
**explicitamente instância única** (`docs/integration-architecture.md` §4.6,
§19; `src/realtime-events/realtime-event-bus.ts` "Single instance only").

## 2. Inventário de runtime process-local

Legenda: **Fonte** = fonte de verdade; **Local** = process-local (L) ou DB (D);
**Restart** = sobrevive a restart; **MI** = seguro com várias instâncias;
**Dup** = risco de execução duplicada; **Líder** = exige liderança/lock
distribuído; **Concorrente** = pode rodar em paralelo com segurança.

| Componente | Fonte | Local | Restart | MI | Dup | Líder | Concorrente |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GameCommandWorker` (`src/game-agent/game-command.worker.ts`), intervalo `GAME_COMMAND_WORKER_INTERVAL_MS` 500 ms | DB (`game_commands`) + sessões locais | L (flag `running`) + D | sim | parcial (§3) | não: lease no DB | não | sim, exceto o orçamento de in-flight |
| `ServerControlWorker` (`src/server-control/server-control.worker.ts`), 1000 ms | DB (`server_control_operations`) | L + D | sim | sim para a garantia; alvo local | não: claim cercado | não | sim |
| `VipDeliveryService.tick` (`src/vip-entitlements/vip-delivery.service.ts`), 2000 ms | DB (`vip_reward_deliveries`) | L + D | sim | sim | não: chave de idempotência + UPDATE cercado | não | sim |
| `AgentWorkNotifier` (`src/game-agent/agent-work.notifier.ts`), 2000 ms | DB (projeções) | L (mapa `told`) | recalcula | sim (push local por natureza) | push repetido é esperado | não | sim |
| Varredura de heartbeat do `AgentGateway.expire` (`src/game-agent/agent.gateway.ts:94`), ≤1000 ms | memória (`lastHeartbeatAt` do registry) + DB | L | não | só sessões locais | não | não | sim |
| `AgentSessionRegistry` (`src/game-agent/agent-session.registry.ts`) | espelho de `game_connections` | L | não | **não** | — | — | — |
| Cadeia de promoção por servidor `AgentGateway.promotions` | memória | L | não | **não** entre instâncias | — | — | — |
| `RealtimeConnectionRegistry` + `RealtimeGateway.staffTokens` | memória | L | não (cliente reconecta) | **não** (bus local) | — | — | — |
| `RealtimeEventBus` (`src/realtime-events/realtime-event-bus.ts`) | nenhuma (best effort) | L | não | **não** | — | — | — |
| `GameServerStatusNotifier` (`src/game-bridge/game-server-status.notifier.ts`), mapas `last` e `chains` | DB (relê após commit) | L | não (1º evento repete) | publica só localmente | duplicata tolerada | não | sim |
| `PlayerAuthRateLimiter` (`src/player-auth/player-auth-rate-limit.ts`) | memória | L | não | **não** (limite × N) | — | — | — |
| `ChatRateLimiter` (`src/player-chat/chat-rate-limiter.ts`) | memória | L | não | **não** | — | — | — |
| Rate limit de frames do Agent (`agent.gateway.ts:267-282`) | memória por socket | L | não | sim (por socket) | — | — | — |
| Mapas de log `blocked`, `held`, `notReady` | memória | L | não | sim (só log) | — | — | — |
| Advisory lock do coordenador (`src/staff/staff.service.ts:23`) | DB | D | — | sim | — | já é lock DB | sim |
| Startup: `AgentGateway.onApplicationBootstrap` → `endAllActive('BACKEND_RESTART')` (`agent.gateway.ts:85`, `src/game-bridge/game-connection.service.ts`) | DB | D | — | **não: fecha sessões de outras instâncias** | — | — | — |
| Shutdown: `onModuleDestroy` do Agent gateway (SHUTDOWN nas sessões), realtime (1001), workers (param timer) | DB + memória | — | — | ver §19 | — | — | — |

Não existe `FOR UPDATE SKIP LOCKED` em lugar nenhum (grep vazio). O único advisory
lock é o do coordenador. A exclusão entre workers vem de locks de linha,
leases e UPDATEs cercados por status (§3).

## 3. Workers

| Worker | Query | Claim | Transação | Idempotência | Duplicado (2 instâncias) | Ponto de crash | Recuperação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GameCommand: `expireCommands` / `expirePending` (`src/game-bridge/game-command-receiver.ts:150-215`) | SELECT até 100 candidatos, sem lock | `store.locked`: `game_servers` FOR UPDATE, depois o command FOR UPDATE, e reavalia o status | uma curta por command | transição de estado fechada; `game_command_results` UNIQUE | seguro: o segundo vê o estado terminal | entre candidatos | o próximo tick recomeça |
| GameCommand: `dispatchEligible` (`src/game-bridge/game-command-dispatcher.ts:222-262`) | due DISPATCHED + PENDING do servidor servido | `reserve()` sob os mesmos locks grava `dispatchLeaseId` (2 s) | reserva comita **antes** do envio; resposta em outra transação cercada pela lease | `commandId` é a identidade de execução; o journal do Agent deduplica | a lease impede reserva dupla; o **orçamento** `AGENT_MAX_IN_FLIGHT_COMMANDS` é lido fora do lock e pode estourar | reservado e não enviado → lease vencida → `markPossiblyDelivered` → retry | at-least-once preservado |
| ServerControl: `expirePending`, `expireResults`, `dispatch` (`src/server-control/server-control-dispatcher.ts`, `server-control-receiver.ts`) | ids PENDING sem claim | UPDATE autocommit cercado (`status=PENDING AND dispatch_claimed_at IS NULL`) | claim comita antes do envio | claim é a fronteira de entrega | seguro: só um UPDATE vence | após o claim nunca reenvia | UNCERTAIN no deadline persistido |
| VIP delivery (`vip-delivery.service.ts:74-228`) | PENDING até 100; COMMAND_CREATED com command terminal (JOIN) | entitlement FOR UPDATE, depois delivery FOR UPDATE, depois `submitInTransaction(key vip-delivery:<id>)` | uma por delivery | chave de idempotência do command + UPDATE cercado | seguro | antes/depois do commit: estado consistente | o reconcile é refeito pelo `game_command_id` |
| Agent work push (`agent-work.notifier.ts`) | primeira página de work por sessão local | nenhum (só leitura) | nenhuma | o Agent deduplica por workId | irrelevante: só o dono do socket envia | — | o Agent faz WORK_SYNC ao reconectar |
| Heartbeat sweep (`agent.gateway.ts:expire`) | sessões locais vencidas | `connections.end` sob lock do server | curta | fecha só se ainda for a sessão ativa | só vê sessões locais | — | — |

Conclusão: todo worker pode rodar em todas as instâncias sem duplicar efeito,
**com três exceções**:
1. o orçamento de in-flight do GameCommand (F-W1);
2. a limpeza de startup, que é global (F-MI1);
3. o alvo do dispatch, que depende do registry local (§5).

Nenhum worker precisa de eleição de líder se essas três forem corrigidas.

## 4. Multi-instância (2 instâncias + 1 PostgreSQL + load balancer)

| Cenário | Comportamento hoje | Classe |
| --- | --- | --- |
| Instância B sobe (restart, rolling deploy, scale-out) | `endAllActive` marca **todas** as `game_connections` CONNECTED como BACKEND_RESTART, inclusive as de A. O próximo heartbeat de cada Agent em A recebe SESSION_CLOSED e o Agent reconecta. Até lá, A reserva GameCommands contra uma conexão que o DB já não tem ativa e consome tentativas (GATEWAY_UNAVAILABLE) | **BLOCKER** |
| Agent em A, HTTP de GameCommand em B | B só persiste (não existe dispatch imediato no HTTP; `src/actor-operations/actor-command.service.ts:31`). O worker de A despacha no próximo tick | SAFE (latência ≤ intervalo do worker) |
| Agent em A, HTTP de Server Control em B | `ServerControlService.request` chama `dispatchSafely` em B; `gateway.target` não acha sessão local, então HELD sem claim. O worker de A faz o claim | SAFE (at-most-once preservado) |
| Worker GameCommand em A e B | Cada um só serve os servidores com sessão **local** (`activeSessions()`). A reserva é exclusiva pela lease. O orçamento pode estourar se as duas instâncias tiverem sessão do mesmo servidor (janela de supersede) | NEEDS_DB_COORDINATION |
| Worker Server Control em A e B | Claim cercado, então exatamente um vence. Mas o claim grava o `connectionId` que o registry **local** achar, sem conferir que é o ativo no DB | NEEDS_DB_COORDINATION |
| VIP delivery worker em A e B | Readiness pelo registry local: B deixa HELD, A cria o command. Criação cercada por chave | SAFE |
| Agent work notifier | Push só a sockets locais; WORK_SYNC relê o DB | SAFE |
| Heartbeat/stale | O DB decide no heartbeat; a varredura só vê sessões locais | SAFE |
| Supersede: o Agent reconecta em B enquanto a sessão antiga segue aberta em A | O HELLO em B marca a linha de A SUPERSEDED no DB, mas o socket e o registry de A continuam ativos até o próximo heartbeat (ou até 30 s se o Agent antigo parar de mandar heartbeat). Nesse intervalo: A consome tentativas de GameCommand; um claim de Server Control em A mira a sessão velha (RESULT recusado, UNCERTAIN); **DOMAIN_EVENT e WORK_SYNC pela sessão velha continuam aceitos** (`src/game-agent/agent-domain.adapter.ts` não revalida no DB) | NEEDS_SOCKET_ROUTING (propagação de close) + NEEDS_DB_COORDINATION |
| Revogação de credencial em B, Agent em A | Linhas fechadas no DB; `sessions.byCredential` de B está vazio, então o socket em A não fecha. A sessão revogada segue enviando DOMAIN_EVENT até o heartbeat de A notar (≤ intervalo) ou até o timeout de 30 s se não houver heartbeat | **BLOCKER** para multi-instância (segurança) |
| Realtime: mutation em B, socket em A | Bus in-process: A nunca recebe. O Player e o Staff só percebem por polling | NEEDS_DISTRIBUTED_BUS |
| Revalidação Staff por entrega | DB, funciona em qualquer instância | SAFE |
| Rate limits (Player auth, chat) | Em memória: o limite efetivo vira N × limite e varia com o balanceamento | NEEDS_DB_COORDINATION (ou store compartilhado) |
| Rate limit de frames do Agent | Por socket | SAFE |
| Promoção serializada de HELLO por servidor | Só dentro do processo. Dois HELLOs em instâncias diferentes são serializados pelo lock de `game_servers` no DB, mas **as duas** instâncias ficam com sessão ACTIVE no registry até a antiga ser notada | NEEDS_SOCKET_ROUTING |
| Shutdown de A | Marca SHUTDOWN só nas próprias sessões | SAFE |
| Staff realtime GameServer notifier | Publica só na instância onde a mudança aconteceu | NEEDS_DISTRIBUTED_BUS |

Hoje só é seguro operar com **exatamente uma instância**, e o deploy precisa
ser do tipo "recreate" (parar a antiga, depois subir a nova), nunca rolling com
sobreposição (P0-5).

## 5. Distribuição do realtime (recomendação para a subetapa multi-instância)

Requisito mínimo: uma mutation que comita em B precisa acordar sockets em A.
Hoje a semântica é best effort: evento pós-commit, duplicata tolerada, sem
ordem, cliente refaz GET. O mesmo requisito vale para o sinal de controle
"feche a sessão do Agent X".

| Critério | PostgreSQL LISTEN/NOTIFY | Redis Pub/Sub | Outbox + polling no PG |
| --- | --- | --- | --- |
| Confiabilidade exigida (best effort) | suficiente; NOTIFY emitido **dentro** da transação só é entregue no commit, alinhado a "after commit" | suficiente; fire-and-forget, perde durante reconexão | acima do necessário (durável) |
| Throughput do projeto (wake-ups < 1 KiB, volume humano/de jogo) | adequado; payload ≤ 8000 B; fila global de notificação do PG exige monitoramento | alto | limitado pelo intervalo de polling |
| Recuperação | reconectar o LISTEN; o cliente refaz GET após reconnect (já é o contrato) | idem | natural |
| Complexidade operacional | nenhuma dependência nova; exige **uma conexão dedicada por instância** fora do pool e é incompatível com PgBouncer em modo transaction | nova infraestrutura (HA, auth, TLS, monitoramento) | tabela e limpeza |

**Recomendação:** LISTEN/NOTIFY no PostgreSQL existente.
- Um canal por tipo de mensagem (`realtime`, `agent_control`). O payload é o envelope já pequeno mais os destinatários (`playerIds` ou `staffPermission`).
- Cada instância faz o fan-out local, como hoje.

Justificativa: o contrato já tolera perda, o volume é baixo, o PostgreSQL já é
obrigatório, e publicar dentro da transação resolve de graça o "after commit".

Revisitar Redis se:
- o volume de NOTIFY se aproximar do limite da fila de notificação;
- o deploy exigir PgBouncer em modo transaction para todas as conexões;
- já houver Redis por outro motivo (rate limit distribuído).

## 6. Roteamento de socket do Agent

Cenário: Agent conectado em A; GameCommand ou Server Control criado em B.

| Opção | Avaliação |
| --- | --- |
| Sticky routing no LB | Não resolve: o problema é o *dispatch* (worker), não a origem do request HTTP. O Agent pode conectar em qualquer instância |
| Gateway do Agent singleton | Simples, mas é SPOF e exige separar o processo. Só vale se a escala for mínima |
| Encaminhamento interno (B → A por RPC) | Nova superfície de rede e de auth, e o envio passa a ser "remoto ambíguo" |
| Fila/bus para comandos | Duplica o que o DB já faz; o risco é criar entrega dupla |
| **Ownership no DB + dispatch pelo dono** (recomendada) | Cada instância só despacha para sessões que ela detém. Já é o comportamento de fato; falta torná-lo explícito e correto |

Requisitos da recomendação:

1. `game_connections` registra a instância dona (id efêmero por processo) e há
   um heartbeat de instância (tabela de lease). A reconciliação de startup fecha
   **só** as linhas de instâncias sem lease válido, não todas (corrige F-MI1).
2. GameCommand: `reserve()` só reserva se a conexão ativa no DB for a sessão
   local, e reconta o in-flight sob o lock de `game_servers` (corrige F-W1).
   Nada muda na semântica at-least-once: uma reserva sem envio já é tratada
   como possivelmente entregue.
3. Server Control: o claim UPDATE passa a exigir, na mesma instrução, que
   `dispatch_connection_id` seja a conexão CONNECTED do servidor
   (`EXISTS ... game_connections WHERE id = :local AND status='CONNECTED'`).
   At-most-once intacto: a fronteira continua sendo o claim, e nunca há reenvio.
4. Close cross-instância (supersede, revogação): sinal `agent_control` pelo bus
   (§5). Como defesa independente do bus, DOMAIN_EVENT, WORK_SYNC e
   COMMAND_ACK devem conferir no DB que a conexão ainda é a ativa. RESULT e
   Server Control RESULT já conferem (`game-command-receiver.ts:259-266`,
   `server-control-receiver.ts:89-97`).
5. Opcional: NOTIFY "work for server S" para B acordar o worker de A sem
   esperar o intervalo.

## 7. Concorrência no banco

Isolation em todo lugar: READ COMMITTED (nenhuma configuração em `src`). Locks
de linha explícitos (FOR UPDATE / FOR SHARE), UPDATEs cercados por status,
índices únicos parciais e `ON CONFLICT` protegem todos os invariantes
persistidos auditados. Detalhe por operação:

| Operação | Mecanismo | Testes de corrida |
| --- | --- | --- |
| Staff login/refresh/logout | `staff_users` e depois `staff_sessions` FOR UPDATE; rotação do hash | `test/auth.e2e-spec.ts` (uso concorrente único do refresh) |
| Player sessão | `players` e depois sessão FOR UPDATE; `player_identities_provider_subject_key` | `test/player-auth.e2e-spec.ts` |
| Credencial do Agent (≤ 2 ACTIVE) | `game_servers` FOR UPDATE + count; trigger de transição | `test/game-agent.e2e-spec.ts` |
| HELLO | server e credencial FOR UPDATE; índice parcial `game_connections_active_key` | `game-agent`, `game-bridge` |
| GameCommand | server e command FOR UPDATE; lease; `ON CONFLICT` na idempotência; `game_command_results` UNIQUE | `game-bridge` (vários), `game-command-agent` |
| Server Control | server FOR UPDATE; `server_control_operations_active_key` parcial; claim/expiração cercados | `server-control`, `server-control-agent` |
| Character link | link e challenge FOR UPDATE; `player_characters_verified_key` parcial | `player-characters` |
| Professions | linha FOR UPDATE; `profession_experience_events_event_key` | `professions` |
| Groups / Guilds | grupo/guild, invite e link FOR UPDATE; índices parciais de membership/leader | `player-groups`, `player-guilds` |
| Economy | contas `ORDER BY id FOR UPDATE`; saldo por trigger; ledger imutável; CHECK de saldo | `economy` |
| Trade / Marketplace | entidade, depois escrow FOR UPDATE; versão da oferta sob lock; UNIQUE de settlement/custody/release | `player-trades`, `player-marketplace` |
| VIP | entitlement e delivery FOR UPDATE; índices parciais ACTIVE; chave determinística | `vip-entitlements` |
| DOMAIN_EVENT | receipt `ON CONFLICT` na transação do domínio; `ReceiptRace` → rollback | `agent-domain-events` |
| Chat / Settings | `ON CONFLICT` + FOR SHARE ordenado / FOR UPDATE | `player-chat`, `player-settings` |

Achados (nenhum HIGH; nenhuma corrida demonstrada quebra invariante persistido):

- **F-DB1 (HARDENING → P2):** orçamento de in-flight contado fora do lock. `game-command.worker.ts:95-100` usa `dispatcher.inFlight()` em autocommit e `reserve()` não reconta. Correto com um worker, estoura com vários.
- **F-DB2 (LOW):** lost update do runtime em `game_connections`. `heartbeat()` faz `save()` da entidade inteira sem lock de linha e `updateRuntime()` faz UPDATE autocommit (`game-connection.service.ts:152-206`). É passageiro: o próximo heartbeat corrige.
- **F-DB3 (LOW):** accept de trade e purchase de marketplace leem link e `player.status` sem lock (`player-trade.service.ts:566,596-603`; `player-marketplace.service.ts:534,545-550`). Numa janela de milissegundos pode comitar com um vínculo recém-revogado. Chat já usa FOR SHARE.
- **F-DB4 (LOW):** `PlayerGroupService.mutate` não mapeia 23505. Um conflito residual viraria 500 em vez de 409 (`player-group.service.ts:69-81`; guilds mapeia).
- **F-DB5 (LOW):** `server.enabled` lido sem lock em create trade, purchase, chat e confirm link. Uma desativação concorrente não bloqueia a operação em curso.
- **F-DB6 (HARDENING):** linhas quentes. A conta de escrow do sistema e `game_servers` FOR UPDATE em todo submit, heartbeat, dispatch, ACK e RESULT do servidor. É throughput, não corretude; medir na subetapa de performance.
- **F-DB7 (HARDENING):** um `QueryFailedError` 23505 não mapeado vira 500 genérico (`src/common/filters/http-exception.filter.ts`). Correto quanto a vazamento, ruim para o cliente.

Lacunas de teste de corrida: accept simultâneo dos dois lados de um trade;
accept contra `updateOffer`; heartbeat contra `updateRuntime`; dois workers
com orçamento de in-flight; VIP `advance` contra revoke; mesmo eventId de
TRADE_SETTLEMENT ou MARKETPLACE_RELEASE em paralelo.

## 8. Matriz de crash e falha

| Fluxo / ponto de crash | Estado persistido | Recuperação automática | Resultado |
| --- | --- | --- | --- |
| **GameCommand** antes da persistência | nada | cliente repete com a mesma Idempotency-Key | SAFE |
| GameCommand persistido, antes do socket | PENDING, talvez com lease | lease vence → `markPossiblyDelivered` → DISPATCHED conservador → retry com o mesmo commandId | RECOVERABLE |
| após socket, antes do ACK | DISPATCHED | retry após o ACK timeout (mesmo commandId; o journal deduplica) → TIMEOUT se esgotar | RECOVERABLE (UNCERTAIN se esgotar tentativas) |
| após execução, antes do RESULT | ACKNOWLEDGED | o Agent reenvia o RESULT do journal por qualquer sessão válida; senão TIMEOUT/EXECUTION_TIMEOUT | RECOVERABLE; UNCERTAIN se o Agent perdeu o journal |
| após RESULT, antes da resposta ao Agent | terminal | RESULT repetido é duplicado idempotente | SAFE |
| **ServerControl** antes do claim | PENDING sem claim | reenviado pelo worker; FAILED/DISPATCH_EXPIRED se expirar | SAFE |
| após claim, antes do send | claim gravado | nunca reenviado; UNCERTAIN no `result_deadline_at` | UNCERTAIN → OPERATOR_ACTION_REQUIRED |
| send ambíguo (timeout de 1 s) | DISPATCHED | aceita RESULT até o deadline | RECOVERABLE ou UNCERTAIN |
| após execução, antes do RESULT | DISPATCHED | o Agent reenvia do journal ao reconectar; senão UNCERTAIN | RECOVERABLE ou UNCERTAIN |
| **DOMAIN_EVENT** antes da transação | nada | o Agent reenvia o mesmo eventId | SAFE |
| mutação de domínio antes do receipt | mesma transação | rollback total | SAFE |
| receipt antes do commit | mesma transação | rollback total | SAFE |
| commit antes do ACK | efeito + receipt | reenvio → `duplicate: true` | SAFE |
| **Trade/Marketplace:** work criado sem Agent | AWAITING / PENDING_CUSTODY / release PENDING | WORK_SYNC ao conectar | RECOVERABLE, **sem expiração**: se o Agent nunca responder, fica preso indefinidamente com GOLD reservado → OPERATOR_ACTION_REQUIRED sem ferramenta |
| Agent executou parcialmente | journal do Agent por workId/linha | WORK_SYNC devolve o mesmo workId; o journal completa o que falta | RECOVERABLE se o journal for durável; senão OPERATOR_ACTION_REQUIRED |
| evento perdido | work segue listado | reenvio com o mesmo eventId | SAFE |
| restart do backend | DB | work reconstruído do DB (provado em `test/stage11-integration.e2e-spec.ts`) | SAFE |
| **VIP** grant | entitlement + delivery na mesma transação | — | SAFE |
| criação da delivery | idem | — | SAFE |
| criação do command | delivery COMMAND_CREATED + command na mesma transação | — | SAFE |
| resultado do command | command terminal | o reconcile espelha pelo `game_command_id` | SAFE |
| crash no reconcile | UPDATE cercado | o próximo tick repete | SAFE; um TIMEOUT vira delivery UNCERTAIN → OPERATOR_ACTION_REQUIRED |
| delivery PENDING sem Agent pronto | PENDING | espera indefinidamente (sem expiração) | OPERATOR_ACTION_REQUIRED sem ferramenta |

Nenhum ponto de crash é BLOCKER para a correção dos dados. Os UNCERTAIN e
OPERATOR_ACTION_REQUIRED são inerentes às garantias escolhidas; o que falta é
ferramenta de operação (§9).

## 9. Recuperação operacional

| Situação | Listar | Inspecionar | Retry seguro | Retry duplica efeito? | Cancelar | Ack manual | Audit da intervenção | No contrato Admin Web |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Server Control UNCERTAIN | sim (`GET game-servers/:id/control/operations?status=UNCERTAIN`) | sim | não; só um novo pedido | **sim, pode** | terminal | não | só o pedido novo | sim |
| GameCommand Staff TIMEOUT/EXECUTION_UNCERTAIN (mutations) | sim (`GET game-servers/:id/commands?status=TIMEOUT`) | sim | não; só um novo pedido | sim para mutations | terminal | não | só o pedido novo | sim |
| GameCommand PENDING sem capability ou Agent | sim | sim | expira sozinho | — | não | — | — | sim |
| Trade AWAITING_GAME_CONFIRMATION sem resposta | **não** (sem Staff API) | não (só os participantes) | não | depende do journal | **não**: nem Player, nem Staff, nem timeout | não | — | não |
| Marketplace purchase AWAITING / listing RESERVED | não | não | não | depende do journal | não | não | — | não |
| Listing PENDING_CUSTODY | não | não | vendedor cancela | custódia tardia → LISTING_NOT_PENDING, item fica no journal do Agent | sim (vendedor) | — | sim (cancel) | não |
| Marketplace release PENDING/FAILED | não | não | não | sim (devolução em dobro) | não | não | — | não |
| VIP delivery FAILED | não | não | não | não (FAILED = sem efeito) | — | não | — | não |
| VIP delivery UNCERTAIN | não | não | não | **sim** | — | não | — | não |
| VIP delivery PENDING preso (Agent nunca pronto) | não | não | espera | — | não | não | — | não |
| Entitlements CHARACTER anteriores à 11.4 sem delivery | não | não | não | — | — | — | — | não |
| Receipts REJECTED finais (ex.: custódia de listing já cancelada) | não | não | — | — | — | — | — | não |
| Credencial do Agent vazada | sim | sim | revogar | — | sim | — | sim | sim |
| Conta Player (suspender, banir, reativar) | não | não | — | — | só por SQL | — | não | não |
| Ajuste manual de saldo | não | não | — | — | só por SQL (ledger imutável exige lançamento compensatório) | — | não | não |
| Moderação de chat (remover mensagem) | não | não | — | — | não existe | — | — | não |
| Último coordenador perdido | CLI `npm run staff:bootstrap` | — | — | — | — | — | sim | — |

Esta tabela define o escopo da subetapa de recuperação operacional.

## 10. Segurança

| Id | Sev. | Componente | Evidência | Risco | Recomendação |
| --- | --- | --- | --- | --- | --- |
| S1 | **HIGH** | Login Staff | `src/auth/auth.controller.ts:40-49`; nenhum throttler em `src` | Força bruta online ilimitada contra contas administrativas. Cada tentativa custa um argon2id de 64 MiB (`src/auth/password.service.ts:9-15`), então requests paralelos também esgotam CPU e memória | Limite por IP e por username com backoff/lockout em store compartilhado; limitar a concorrência de hashing |
| S2 | MEDIUM | Proxy | nenhum `trust proxy`; `player-auth-rate-limit.ts:55-57` usa `request.ip` | Atrás de um reverse proxy todos os Players compartilham um bucket de 20/min (DoS de login), e `audit_logs.ip_address` registra o proxy | `trust proxy` configurável por env com a lista de proxies |
| S3 | MEDIUM | Refresh Staff/Player | `auth.service.ts:103-107`; `player-auth.service.ts:67-71` | Sem detecção de reuso: se um refresh vazado for girado primeiro pelo atacante, a vítima só recebe 401 e o atacante mantém a sessão | Mismatch com sessão válida → revogar a sessão e auditar |
| S4 | MEDIUM | WebSocket | `realtime.gateway.ts:134-186`; `agent.gateway.ts:134-219` | Sem teto de sockets por IP, por identidade, no total ou para não autenticados; cada HELLO abre transação com FOR UPDATE em `game_servers` (`agent-auth.service.ts:51-63`) | Limites por IP e por identidade; limite de HELLO; validação sem lock antes |
| S5 | MEDIUM (se o DB for remoto) | DB | `src/database/database.options.ts` sem `ssl` | Credenciais e dados em claro na rede até o DB | Env de SSL (modo, CA) obrigatória quando o host não é local |
| S6 | LOW | Realtime Player | `realtime.gateway.ts:155-169` | Player banido ou deslogado segue recebendo wake-ups até o access expirar (≤ 15 min) | Fechar no logout/status; ou revalidar como no Staff |
| S7 | LOW | WS Origin | `src/websocket/websocket-upgrade.router.ts` | Sem allowlist de Origin (impacto baixo: o token vai no frame, não em cookie) | Allowlist opcional para `/realtime` |
| S8 | HARDENING | Swagger | `src/setup-app.ts:24-30` | `/docs` e `/docs-json` públicos em qualquer ambiente | Desligar ou proteger em produção |
| S9 | HARDENING | Headers | sem helmet; `X-Powered-By` presente | Sem HSTS, nosniff, frame-ancestors | Headers de segurança; desativar `x-powered-by` |
| S10 | HARDENING | Body | `main.ts` usa o default de 100 kb do Express | Limite implícito, não documentado | Limite explícito |
| S11 | HARDENING | Audit sanitizer | `src/audit/metadata-sanitizer.ts:5-6` | Não bloqueia `message/content/challenge/payload`; a proteção depende da allowlist dos chamadores | Estender o padrão ou testar a allowlist por action |
| S12 | HARDENING | Segredos JWT | `src/config/environment.ts:204-224` | Só exige ≥ 32 caracteres (aceita baixa entropia) | Exigir ≥ 32 bytes aleatórios (base64) |
| S13 | HARDENING | `PermissionGuard` | `src/rbac/permission.guard.ts:19-24` | Fail-open: handler Staff sem `@RequirePermissions` libera qualquer Staff autenticado | Negar por padrão quando falta metadata, com opt-out explícito |
| S14 | HARDENING | `NODE_ENV=test` em produção | `environment.ts:139,430` | Boot com segredos aleatórios por processo | Recusar `test` fora de testes ou exigir os segredos quando houver marcador de produção |
| S15 | P2 (dep.) | `multer` via `@nestjs/platform-express` 12.0.1 | `npm audit`: 2 HIGH (GHSA-wc9g-mqfw-jrwm, -qfvm-cv95-jqjf, -qvfw-j98x-7q72, -535w-7cp7-47q4) | O projeto não usa multipart/upload (grep vazio), então **não é alcançável** | Atualizar `@nestjs/platform-express` para a versão corrigida, isoladamente, com a suíte completa |

O que está sólido (verificado):
- JWT HS256 com `algorithms`, issuer, audience e `typ` fixados, com segredos e audiences separados entre Staff e Player (`src/auth/token.service.ts:43-103`, `src/player-auth/player-token.service.ts`);
- argon2id; login sem enumeração (hash dummy);
- segredo do Agent de 32 bytes, sha256 + `timingSafeEqual`;
- `ValidationPipe` global com whitelist e `forbidNonWhitelisted`;
- SQL sempre parametrizado (as interpolações são só de constantes);
- Discord com URLs fixas e `redirectUri` por allowlist exata;
- nenhum `child_process`/`eval`/acesso a arquivo;
- filtro de exceção sem stack nem erro de driver;
- ownership sempre derivado do token nas rotas Player;
- GETs tipados de Staff exigem a permissão do tipo gravado.

## 11. Abuso e rate limits

Baseline atual (defaults são ponto de partida, não verdade):

| Superfície | Limite hoje | Chave | Store | Recomendação (chave / janela / limiar) | Distribuído? |
| --- | --- | --- | --- | --- | --- |
| Player `discord/exchange`, `refresh`, `POST character-links` | 20/60 s fixo | `handler:ip` | memória | ip real (após `trust proxy`) + subject quando conhecido; limiares a calibrar com a subetapa de performance | sim |
| Staff `auth/login` | **nenhum** | — | — | ip **e** username; backoff exponencial/lockout temporário; limitar hashing concorrente | sim |
| Staff `auth/refresh` | nenhum | — | — | ip | sim |
| Frames do Agent | 200/10 s por sessão | socket | memória | manter | não |
| HELLO do Agent | nenhum (1 por socket) | — | — | ip + gameServerId | sim |
| Realtime connect/AUTH | nenhum (1 por socket) | — | — | ip; sockets por identidade | sim |
| Chat send | 5/10 s deslizante | player+character | memória | manter a chave | sim |
| GameCommand Staff | só RBAC | — | — | staffId (proteção contra script/erro humano) | sim |
| Operações Player (queries) | nenhum | — | — | playerId; teto de PENDING por player | sim |
| Trade, Marketplace, convites | nenhum | — | — | playerId por operação | sim |
| Credenciais do Agent | RBAC + ≤ 2 ACTIVE | — | DB | suficiente | — |

Nenhum número novo é fixado aqui: os limiares saem das medições de performance.

## 12. Limites de recursos

Existentes: frame do Agent 128 KiB; frame do realtime 16 KiB; token ≤ 4096;
buffer de saída do realtime 256 KiB (acima disso o socket é derrubado); chat 500
caracteres (CHECK); payload/result de GameCommand 4 KiB / 64 KiB (CHECK);
metadata de Audit 8 KiB; `limit ≤ 100`; WORK_SYNC 50 itens / 96 KiB; in-flight
32 por servidor; oferta VIP 20 rewards / 32 KiB. Não há uploads.

| Id | Problema | Evidência | Classe | Sev. |
| --- | --- | --- | --- | --- |
| R1 | Sockets realtime e Agent sem teto (ver S4) | `realtime-connection.registry.ts` | OOM / DB amplification | MEDIUM |
| R2 | Fan-out Staff reautentica por socket e por evento (2 queries) | `realtime.gateway.ts:92-126` | DB amplification | MEDIUM (escala com Staff × eventos) |
| R3 | Envio ao Agent sem `bufferedAmount` | `agent-session.registry.ts:128-131` | OOM | LOW |
| R4 | Realtime sem ping/pong: socket meio aberto vive até o token expirar | `realtime.gateway.ts` | OOM lento | LOW |
| R5 | `page ≤ 1.000.000` × `limit` 100 → OFFSET até 1e8 + `getManyAndCount` | `admin-queries/dto/query.dto.ts:29` | DB amplification | LOW |
| R6 | Listas sem take: staff, credenciais do Agent (revogadas acumulam), VIP `forPlayer`/`forCharacter`/`effective` | `staff.service.ts:43-47`, `agent-credential.service.ts:62-69`, `vip-entitlement.service.ts:471-575` | large response | LOW |
| R7 | O mapa do limiter de auth só é podado acima de 10k chaves e percorre O(n) por request | `player-auth-rate-limit.ts:31-34` | event loop | LOW |
| R8 | Sem teto de PENDING por ator na criação de GameCommand/ServerControl | `game-command-bus.ts` | crescimento do DB | LOW |
| R9 | `audit_logs.metadata` sem CHECK de tamanho no DB (só na aplicação) | migration AuditLog | — | HARDENING |

## 13. Observabilidade

Existe:
- logs de texto do Nest `Logger` com pares `[chave=valor]` (não JSON);
- `x-request-id` gerado ou propagado (`src/common/middleware/request-id.middleware.ts`) e gravado no Audit e nas operações (`requestId`);
- `correlationId` nos GameCommands e no Server Control;
- `commandId`, `operationId`, `eventId`, `workId` e `deliveryId` nos logs do Agent/workers;
- Audit append-only (trigger ALWAYS);
- contador em memória de UNCERTAIN (`ServerControlWorker.uncertainCount()`), só em log;
- `/api/v1/health` com `SELECT 1`.

Não existe: métricas exportadas, tracing, dashboards, alertas, logs JSON.

Métricas mínimas para produção (nomes indicativos):

| Área | Métrica |
| --- | --- |
| HTTP | `http_requests_total{route,method,status}`, `http_request_duration_seconds` (histograma), taxa de 5xx |
| DB | pool em uso, ociosas e espera; erros de query por código (23505, 40001, timeout); duração |
| Agent | `agent_sessions_active{server}`, `agent_auth_failures_total{reason}`, `agent_heartbeat_stale_total`, `agent_reconnects_total`, `agent_supersede_total`, `agent_frames_rate_limited_total` |
| GameCommand | gauge por status (PENDING, DISPATCHED, ACKNOWLEDGED) e contador de terminais (SUCCEEDED, FAILED, TIMEOUT por errorCode); latência criação→dispatch, dispatch→ACK, ACK→RESULT |
| Server Control | contagem por status; `server_control_uncertain_total` |
| Domain | `domain_event_receipts_total{kind,status}`, conflitos (EVENT_CONFLICT), work pendente por kind e idade do mais antigo, trades AWAITING, purchases AWAITING, releases PENDING/FAILED |
| VIP | deliveries por status; idade da PENDING mais antiga |
| Realtime | conexões por surface, desconexões por close code, `realtime_slow_client_drops_total`, falhas de reautorização Staff |
| Workers | duração do tick, erros de tick, itens processados por tick, ticks pulados por overlap |

Os gauges de estado persistido devem vir de consultas agregadas ao DB, não de
memória, para ficarem corretos com várias instâncias.

## 14. Health e readiness

Hoje há um único endpoint: `GET /api/v1/health` → 200 `{status:'ok', database:'up'}`
ou 503 (`src/health/health.service.ts`). Não há liveness separada, não confere
migrations nem sinaliza shutdown.

Contrato proposto (independente de orquestrador):

| Probe | Deve responder | Não deve depender de |
| --- | --- | --- |
| Liveness `GET /api/v1/health/live` | processo e event loop respondendo (sem I/O) | DB, Agent |
| Readiness `GET /api/v1/health/ready` | DB acessível; nenhuma migration pendente (checada no boot, cacheada); bootstrap concluído (workers e upgrade router registrados); 503 assim que o shutdown começa | **Agent/Skyrim**: ausência do Agent não tira a instância de tráfego |
| Informativo (Staff) | Agents e workers (último tick, erros) | — |

O `/health` atual pode continuar como alias da readiness por compatibilidade.

## 15. Logs e privacidade

Verificado:
- nenhum log de senha, JWT, refresh, segredo do Agent, challenge, conteúdo de chat nem payload/result de GameCommand;
- o logger do DB (`src/database/logging/safe-database.logger.ts`) não registra SQL nem parâmetros;
- o filtro de exceção loga só o nome do erro;
- `console.*` aparece só no bootstrap CLI, com mensagens fixas;
- identificadores são validados (UUID/regex) antes de ir para o log, o que evita injeção de linha.

Política de redaction para a Stage 12 (manter o que já funciona e tornar
verificável):
1. Log estruturado JSON com campos fixos (`requestId`, `gameServerId`, `commandId`, …) em vez de texto livre.
2. Proibido em logs: segredos, tokens, hashes, challenge, conteúdo de chat, payload/result de comando, corpo de request, headers de auth, IP completo, se a política de privacidade exigir.
3. Teste de fronteira que falhe se um logger interpolar essas variáveis.
4. Audit: allowlist por action, com teste.
5. Retenção de logs e do Audit definida pelo operador (LGPD).

## 16. Env e config

A validação é Joi, falha no boot com `abortEarly:false` e checa relações entre
valores (`src/config/environment.ts:322-386`). Não há segredo com default fora
de test. Classificação:

| Classe | Variáveis |
| --- | --- |
| REQUIRED | `DB_HOST`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PLAYER_JWT_ACCESS_SECRET`, `PLAYER_JWT_REFRESH_SECRET` (segredos opcionais só com `NODE_ENV=test`) |
| OPTIONAL_WITH_SAFE_DEFAULT | `PORT` 3000, `DB_PORT` 5432, TTLs de JWT (15m/7d; Player 15m/30d), `PLAYER_AUTH_RATE_LIMIT_PER_MINUTE` 20, `PLAYER_LINK_CHALLENGE_TTL` 10m, `PLAYER_GROUP_INVITE_TTL` 10m, `PLAYER_GUILD_INVITE_TTL` 7d, `PLAYER_CHAT_RETENTION` 7d, `PLAYER_CHAT_RATE_LIMIT_COUNT` 5, `PLAYER_CHAT_RATE_LIMIT_WINDOW` 10s, `REALTIME_AUTH_TIMEOUT_MS` 5000, `GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS` 30000, `GAME_COMMAND_*` (ACK 5000, EXECUTION 30000, MAX_ATTEMPTS 3, PENDING 60000, WORKER 500), `SERVER_CONTROL_*` (PENDING 30000, WINDOW 10000, RESULT 300000, WORKER 1000), `AGENT_AUTH_TIMEOUT_MS` 5000, `AGENT_HEARTBEAT_INTERVAL` 10s, `AGENT_HEARTBEAT_TIMEOUT` 30s, `AGENT_MAX_IN_FLIGHT_COMMANDS` 32, `AGENT_MESSAGE_RATE_LIMIT_COUNT` 200, `AGENT_MESSAGE_RATE_LIMIT_WINDOW_MS` 10000, `AGENT_WORK_PUSH_INTERVAL_MS` 2000, `VIP_DELIVERY_WORKER_INTERVAL_MS` 2000 |
| OPTIONAL (feature) | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URIS` (tudo ou nada; sem eles o exchange responde 503) |
| OPTIONAL (atenção) | `NODE_ENV` (default `development`), `DB_LOGGING` (default: ligado em development) |
| DEV/OPS_ONLY | `BOOTSTRAP_COORDINATOR_USERNAME`, `_DISPLAY_NAME`, `_PASSWORD` (sem validação de força; remover após o uso); `POSTGRES_*` do compose |
| TEST_ONLY | `TEST_DATABASE_INTEGRATION` |

Achados:
- **C1 (P1):** `NODE_ENV` ausente vira `development` (liga DB_LOGGING). Produção deve exigir `NODE_ENV=production` explícito.
- **C2 (P1):** sem SSL, `max` do pool (pg usa 10), `idleTimeoutMillis` e `statement_timeout`.
- **C3 (P1):** `query_timeout: 5000` é só do cliente (a query segue no servidor) e **vale também para o CLI de migration** (`database.options.ts:17-21`). Um bloco longo de migration aborta em 5 s.
- **C4 (LOW):** relações não checadas: ACK > EXECUTION; PENDING_TIMEOUT < WORKER_INTERVAL (GameCommand e Server Control).
- **C5 (HARDENING):** unidades misturadas (`_MS` inteiro; TTL em string convertida para segundos ou ms, como `AGENT_HEARTBEAT_*` sem sufixo).
- **C6 (HARDENING):** ver S14 (`NODE_ENV=test`).

## 17. Migrations e release

As 25 migrations usam a transação padrão do TypeORM (`all`: todas as pendentes
numa transação só). Nenhuma usa `transaction = false`, `CONCURRENTLY` ou
`NOT VALID`.

Riscos:
- **M1 (MEDIUM, histórico):** GenericActor, CharacterResultLimit e GameAgentTransport fazem CHECK/FK validados, UNIQUE reconstruído e `CREATE INDEX` sem CONCURRENTLY sob ACCESS EXCLUSIVE em tabelas que crescem (`audit_logs`, `game_commands`, `game_command_results`, `game_connections`). Não importa num banco novo; importa se alguma for aplicada a um banco grande.
- **M2 (MEDIUM):** a transação única de todas as pendentes, somada ao `query_timeout` de 5 s e à falta de `lock_timeout`, faz locks ficarem retidos até o COMMIT final e aborta blocos longos.
- **M3 (MEDIUM):** ServerControlTransport não é compatível com o app anterior (`claim_check`, índice único) e fez backfill fechando operações abertas. É histórico, mas mostra que nem toda migration é "expand".
- **M4 (MEDIUM):** o down de AgentDomainEvents só recusa com obrigações abertas. Um down seguido de up com releases já concluídas refaz o backfill e **devolveria itens em dobro**, e apaga os receipts (dedup).
- **M5 (LOW):** vários downs apagam dados sem guarda (AuthRbac, AuditLog, PlayerAccounts, Professions, …).
- **M6 (HARDENING → P1 no smoke):** VipStore usa `uuid_generate_v4()` sem criar `uuid-ossp`; depende do `installExtensions` do TypeORM. Em DB gerenciado sem permissão de CREATE EXTENSION a primeira instalação falha.

Política para a Stage 12:
1. Forward-only. Rodar `migration:run` com a versão nova **antes** de subir o app novo, com o app antigo parado enquanto houver instância única.
2. Mudanças novas no padrão expand/contract: colunas nullable ou com default constante; `ADD CONSTRAINT … NOT VALID` + `VALIDATE` separado; `CREATE INDEX CONCURRENTLY` em migration com `transaction = false`; backfills grandes fora da migration, em lotes.
3. `SET LOCAL lock_timeout` e `statement_timeout` explícitos nas migrations novas; o CLI de migration sem o `query_timeout` de 5 s.
4. Backup verificado (dump ou snapshot, ou PITR confirmado) imediatamente antes de cada `migration:run` em produção.
5. Não usar `migration:revert` em produção. A exceção é a última migration, recém-aplicada, sem dados novos e com o app parado. **Nunca** fazer down seguido de up em AgentDomainEvents. Rollback = restaurar backup ou migration corretiva.
6. Smoke pós-migration:
   - `migration:show` sem pendências;
   - 25+ linhas em `migrations`;
   - 37 permissions / 95 grants;
   - triggers ALWAYS de `audit_logs` e do ledger ativos;
   - readiness 200;
   - login Staff;
   - HELLO de um Agent de staging.

## 18. Backup e restore

O repositório não implementa backup (esperado). Requisito operacional mínimo, com
os valores a decidir pelo operador:

| Item | Requisito | Decisão do operador |
| --- | --- | --- |
| Backup | PITR (base backup + WAL) no PostgreSQL de produção, ou dumps lógicos se o volume permitir | RPO: faixa típica de minutos (PITR) a 24 h (dump diário). O ledger econômico e o Audit pesam para RPO baixo |
| Retenção | diária por N dias + semanal/mensal | N conforme custo e LGPD |
| Restore test | restaurar em ambiente isolado, subir o app, rodar o smoke (§17) e comparar contagens de tabelas-chave | frequência (por release e periódica) |
| RTO | tempo medido no restore test, não estimado | alvo |
| Pós-restore | sockets do Agent reconectam e fazem WORK_SYNC; GameCommand/ServerControl abertos seguem as garantias; operações posteriores ao ponto de restore somem (o Agent pode ter efeitos físicos que o backend "esqueceu": exige reconciliação manual) | procedimento documentado |
| Segredos | JWT, DB e Discord em cofre fora do backup do DB | onde |

## 19. Deploy

Estado atual:
- não há Dockerfile, imagem nem manifest;
- `docker-compose.yml` só sobe o PostgreSQL 16 em `127.0.0.1` (dev);
- `.env.example` existe;
- start `node dist/main.js` (`start:prod`) e migrations `npm run migration:run` (faz build antes: inadequado em imagem de produção);
- health `GET /api/v1/health`;
- `enableShutdownHooks()` (`src/setup-app.ts:22`);
- sem suporte a TLS no processo (espera terminação no proxy);
- sem `trust proxy`;
- o WebSocket usa o upgrade HTTP no mesmo porto (o proxy precisa encaminhar `Upgrade`/`Connection` e ter timeout de inatividade acima do heartbeat do Agent de 10 s; realtime não tem ping, ver R4);
- sem storage persistente além do PostgreSQL.

Gaps para um deploy real:
1. Imagem de produção reproduzível (build multi-stage, usuário não-root, `npm ci --omit=dev`).
2. Comando de migration sem rebuild (`typeorm migration:run -d dist/database/data-source.js`) como passo separado do start.
3. Probes de liveness/readiness (§14).
4. Configuração do proxy: TLS, headers, upgrade, timeouts, `trust proxy`.
5. Estratégia de deploy "recreate" enquanto houver instância única (§4).
6. Runbook de deploy, rollback e restore.

## 20. Graceful shutdown

Com `enableShutdownHooks`, SIGTERM/SIGINT disparam `app.close()`:
- `onModuleDestroy` dos workers para os timers (flag `stopped`);
- o Agent gateway grava SHUTDOWN nas sessões e fecha os sockets com 1001;
- o realtime fecha os sockets com 1001;
- o servidor HTTP fecha;
- o TypeORM destrói o pool.

Gaps:
- **G1:** um tick de worker em andamento não é aguardado. O pool pode ser destruído no meio dele, o que dá "tick failed" no log. A semântica fica preservada: a lease vira possivelmente entregue (GameCommand) e o claim nunca é reenviado (Server Control → UNCERTAIN no deadline). Mesmo assim a saída não é limpa.
- **G2:** não há fase de drenagem. A readiness não vira 503 antes do fechamento, e não há espera configurável para o LB tirar a instância.
- **G3:** requests HTTP em curso não têm timeout de encerramento definido.
- **G4:** o fechamento das sessões do Agent no shutdown ocorre enquanto os workers ainda podem estar reservando (sem ordem garantida entre `onModuleDestroy` de módulos diferentes).

Nenhum gap quebra at-least-once nem at-most-once, porque as garantias estão no
DB. São problemas de higiene de encerramento e de erro visível.

## 21. Dependências

- `npm audit`: 2 HIGH, ambos em `multer` ≤ 2.2.0, trazido por `@nestjs/platform-express` 12.0.1 (runtime). O projeto não registra multipart, então os advisories de DoS e bypass de limite de arquivo não são alcançáveis por nenhuma rota. Risco de quebra do upgrade: baixo (patch do Nest), mas precisa rodar a suíte completa. Não foi aplicado `npm audit fix` (fora do escopo da 12.0).
- Nenhuma dependência de runtime além das 17 listadas em `package.json`; sem Redis, ORM extra ou cliente HTTP (usa o `fetch` nativo).
- `engines.node >=22`; medido em 24.18.0. Fixar a versão de Node da imagem.

## 22. Suíte de testes

| Aspecto | Estado |
| --- | --- |
| Duração | unit 3,9 s (38 suítes, paralelas); e2e 225 s (33 suítes, `--runInBand`), sem contar o `pretest:e2e` (build) |
| Isolamento | cada suíte e2e cria um schema próprio no PostgreSQL real e roda as 25 migrations; sem mocks de DB |
| Flakiness | nenhum flake observado nas execuções da Etapa 11 (suítes de realtime/Agent repetidas 3× sem falha). A suíte depende de temporizações reais (deadlines de 1–5 s): sensível a CI lento |
| Corrida | `Promise.all` concorrente em ≥ 12 suítes (game-bridge, marketplace, guilds, trades, chat, VIP, economy…); lacunas no §7 |
| Migrations | 31 suítes aplicam as migrations; up, down e re-up testados para as últimas etapas; diff de schema 0/0 |
| Agent | `test/support/fake-agent.ts` fala o protocolo v1 real sobre sockets reais, com journal **simulado**. Não é teste de contrato do executável real |
| Faltam | teste com duas instâncias do app sobre o mesmo DB; contrato com o Agent real (fixtures gravadas e replay); smoke de imagem/deploy; teste de restore; carga/soak; shutdown com tick em andamento |

## 23. Plano de baseline de performance (subetapa de carga)

Cenários, com as métricas p50/p95/p99, throughput sustentado, taxa de erro, uso de
CPU/memória, conexões do pool e duração dos locks. Os SLAs são definidos pelo
produto a partir das medições.

| Cenário | Carga | Observar |
| --- | --- | --- |
| GET `/dashboard` (Staff) | N Staff em polling | latência, custo das agregações |
| Login/refresh Player e login Staff | rajadas | argon2 (CPU/memória por tentativa), throughput do refresh |
| Discovery `GET /player/game-servers` | muitos Players no startup do Electron | latência, pool |
| Chat send + fan-out | canais GLOBAL/GROUP/GUILD cheios | latência de envio, frames/s, drops por cliente lento |
| Submit de GameCommand (Staff/Player) | rajada por servidor | lock de `game_servers`, fila PENDING |
| ACK/RESULT do Agent | vários servidores × in-flight 32 | commits/s, latência RESULT→terminal |
| DOMAIN_EVENT | eventos por segundo por servidor | receipts/s, contenção de escrow |
| WORK_SYNC | milhares de itens de work | tempo por página, custo das queries keyset |
| Realtime fan-out | milhares de sockets Player, dezenas de Staff | memória por socket, custo da reautorização Staff (R2) |
| Soak | 24 h com Agents reconectando | vazamento de memória (mapas, sockets), crescimento de tabelas |

## 24. Integrações externas não validadas ponta a ponta

| Componente | Validado aqui | Necessário antes do release |
| --- | --- | --- |
| Host Agent real | não (só FakeAgent) | smoke em staging: HELLO, heartbeat, GameCommand query e mutation com dedup real, Server Control nos três tipos, DOMAIN_EVENT e WORK_SYNC com journal durável, reconexão e restart do Agent |
| Plugin SKSE | não | as capabilities anunciadas batem com a execução real; tempos reais de ACK/RESULT versus os timeouts |
| Electron | não | fluxo Player completo contra staging, incluindo reconnect do realtime e cold start |
| C# Launcher / IPC | não | contrato IPC validado no repo externo |
| Discord OAuth real | não (FakeDiscordProvider) | exchange com app Discord de staging e redirect URIs de produção |
| Reverse proxy / TLS | não | upgrade WS nos dois paths, timeouts, headers, `trust proxy` |
| PostgreSQL de produção | não | versão ≥ 13, `uuid-ossp` disponível ou pré-criada, SSL, pool, backup/PITR |

## 25. Findings consolidados

| Id | P | Componente | Evidência | Risco | Correção | Subetapa |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 | P0 | Login Staff (S1) | `auth.controller.ts:40-49` | força bruta e exaustão de CPU/memória | rate limit + lockout + teto de hashing | 12.1 |
| P0-2 | P0 | Proxy (S2) | sem `trust proxy` | limite de Player vira global atrás do proxy; IP errado no Audit | `trust proxy` por env | 12.1 |
| P0-3 | P0 | Deploy (§19) | sem imagem, sem runbook, migration com rebuild | deploy não reproduzível | imagem + comando de migration + runbook | 12.2 |
| P0-4 | P0 | Backup (§18) | inexistente | perda irreversível do ledger e do Audit | PITR/dump + restore test executado | 12.2 |
| P0-5 | P0 | Instância única (§4, F-MI1) | `endAllActive` global; registry e bus locais | 2 réplicas ou deploy rolling derrubam Agents e quebram realtime/revogação | forçar réplica única + deploy recreate e documentar, até a 12.5 | 12.2 |
| P0-6 | P0 | Agent/SKSE real (§24) | só FakeAgent | gameplay sem validação do executável | smoke de staging com o Agent real | 12.7 |
| P1-1 | P1 | Refresh reuse (S3) | `auth.service.ts:103-107` | sessão sequestrada persiste | detectar reuso → revogar | 12.1 |
| P1-2 | P1 | Limites WS/HELLO (S4, R1, R2) | gateways | exaustão de sockets e do DB | tetos por IP/identidade; limite de HELLO; cache curto da autorização Staff | 12.1 |
| P1-3 | P1 | Headers, Swagger, body (S8–S10) | `setup-app.ts` | exposição e defaults implícitos | headers, `/docs` fora de produção, limite explícito | 12.1 |
| P1-4 | P1 | DB SSL/pool/timeouts (S5, C2, C3) | `database.options.ts` | tráfego em claro; migrations abortando | env de SSL, pool e statement/lock timeouts; CLI sem o query_timeout | 12.2 |
| P1-5 | P1 | `NODE_ENV` (C1, S14) | `environment.ts` | modo dev ou test em produção | exigir `production` explícito | 12.2 |
| P1-6 | P1 | Health (§14) | um endpoint | orquestrador sem liveness/readiness nem drenagem | `/live` e `/ready` + readiness 503 no shutdown | 12.2 |
| P1-7 | P1 | Graceful shutdown (G1–G4) | §20 | erros e ordem indefinida no encerramento | aguardar ticks, drenagem, ordem de destroy | 12.2 |
| P1-8 | P1 | Métricas/alertas (§13) | inexistentes | UNCERTAIN, work preso e Agent offline invisíveis | métricas mínimas + alertas | 12.3 |
| P1-9 | P1 | Recuperação operacional (§9) | sem API para Trade/Marketplace/release/VIP/conta Player | GOLD reservado indefinidamente; itens sem devolução; ação só por SQL | listagens, inspeção e ações seguras auditadas (acknowledge, cancel quando não houve efeito, retry idempotente) + timeout operacional | 12.4 |
| P1-10 | P1 | Migrations (M2, M4, M6) | §17 | lock e timeout em deploy; devolução em dobro; falha em DB gerenciado | política da §17 + smoke + guarda no down de AgentDomainEvents + pré-requisito `uuid-ossp` | 12.2 |
| P1-11 | P1 | Electron, Discord, proxy reais (§24) | não validados | fluxo Player não comprovado | smoke de staging | 12.7 |
| P2-1 | P2 | Ownership de sessão do Agent (§6, F-MI1) | registry local; startup global | multi-instância | ownership por instância + lease + reconciliação por instância | 12.5 |
| P2-2 | P2 | Revogação/supersede cross-instância | `agent-domain.adapter.ts` sem revalidação no DB | sessão revogada aceita DOMAIN_EVENT em outra instância | sinal de controle pelo bus + revalidação no DB | 12.5 |
| P2-3 | P2 | Bus realtime distribuído (§5) | bus in-process | wake-up perdido entre instâncias | LISTEN/NOTIFY | 12.5 |
| P2-4 | P2 | Orçamento de in-flight e alvo do claim (F-DB1, §6) | `game-command.worker.ts:95-100`; claim sem conferir a conexão ativa | estouro do orçamento; UNCERTAIN desnecessário | recontar sob lock; claim condicionado à conexão ativa | 12.5 |
| P2-5 | P2 | Rate limits distribuídos (§11) | limiters em memória | limites × N | store compartilhado (PostgreSQL ou Redis, decidir na 12.5) | 12.5 |
| P2-6 | P2 | Carga e soak (§23) | nenhum | limites e SLAs desconhecidos | cenários da §23 | 12.6 |
| P2-7 | P2 | `multer` (S15) | npm audit | não alcançável hoje | atualizar `@nestjs/platform-express` isoladamente | 12.1 |
| P2-8 | P2 | Testes de corrida faltantes (§7) | — | regressões não detectadas | testes listados | 12.4 / 12.5 |
| P3-1 | P3 | F-DB2…F-DB7, R3–R9, S6, S7, S11–S13, C4, C5, M5 | seções acima | baixo | agrupar em lotes de hardening | 12.1–12.4 conforme a área |
| P3-2 | P3 | Logs JSON e tracing | §13, §15 | diagnóstico mais lento | log estruturado; tracing opcional | 12.3 |

## 25.1 Status após a 12.1

Detalhes em `docs/security.md`. Evidência: `test/security.e2e-spec.ts` e os
testes unitários citados lá.

| Finding | Status | Como |
| --- | --- | --- |
| P0-1 / S1 login Staff | **resolvido** | buckets por IP e por username antes do Argon2; teto de Argon2 simultâneos; 429 genérico com Retry-After |
| P0-2 / S2 proxy | **resolvido** | `TRUST_PROXY` explícito (`true` recusado), uma política para `request.ip`, rate limit, Audit e WebSocket |
| P1-1 / S3 reuso de refresh | **resolvido** | detecção sem migration (token válido e não atual = rotacionado; janela de graça para corrida); revoga só a sessão; Audit Staff e Player |
| P1-2 / S4, R1 limites WS/HELLO | **resolvido** para instância única | Origin, tentativas por IP, pendentes, total e por identidade no realtime; tentativas, falhas, pendentes e HELLO simultâneos no Agent |
| P1-2 / R2 reautorização Staff por evento | aberto | mantida a revalidação por entrega (correta); cache curto fica para a 12.6, se a carga pedir |
| P1-3 / S8–S10 headers, Swagger, body | **resolvido** | Helmet com CSP de API; `SWAGGER_ENABLED` desligado em produção; body de 100 kB testado; 413 em vez de 500 |
| S7 Origin WebSocket | **resolvido** | `REALTIME_ALLOWED_ORIGINS`; o Agent ignora Origin por desenho |
| S13 PermissionGuard | **resolvido** | fail-closed + `@PermissionsCheckedInService()` + validação no startup + teste estrutural |
| R7 mapa do limiter de auth | **resolvido** | `MemoryRateLimiter` limitado (50 000 chaves, poda e descarte) |
| R8 / §11 mutations Player | **parcial** | limites por player em character queries e trade/listing/purchase/cancel; Staff GameCommand, convites, offer/accept de trade e chat reads seguem sem limite próprio |
| S6 socket Player após logout/revogação | **resolvido** (instância única) | logout e reuso de refresh fecham, após o commit, os sockets da mesma sessão (4001 `SESSION_REVOKED`); outras sessões não são afetadas |
| S6 socket Player após ban/suspend | aberto (gap operacional, 12.4) | não há mutation de status de conta Player (só SQL); manual DB account-status changes do not proactively close existing Player realtime sockets |
| S11, S12, S14 | aberto | hardening restante |
| P2-7 / S15 multer | aberto (não alcançável) | proposta: `@nestjs/*` 12.1.x (platform-express 12.1.0 → multer 2.4.0), num commit isolado |
| P2-5 rate limits distribuídos | aberto | a interface `RateLimiter` já isola o store; implementação compartilhada na 12.5 |

## 25.2 Status após a 12.2

Runbook em `docs/deployment.md`, backup/restore em `docs/backup-restore.md`,
proxy em `docs/reverse-proxy.md`, variáveis em `docs/configuration.md`.

| Finding | Status | Como |
| --- | --- | --- |
| P0-3 deploy | **resolvido** (falta CI) | `Dockerfile` multi-stage não-root, construído e testado localmente; `migrate` e `preflight` compilados, sem rebuild; runbook recreate |
| P0-4 backup | **ferramenta pronta e testada**; decisões abertas | `scripts/db-backup.sh` e `scripts/db-restore-verify.sh`; restore test local executado com sucesso; RPO, RTO e retenção TO BE DECIDED |
| P0-5 instância única / F-MI1 | **imposto** | advisory lock `pg_advisory_lock(1397446994, 1)` numa conexão dedicada durante toda a vida do processo; segunda instância e migration concorrente recusadas; lock perdido encerra a instância. O `endAllActive` global continua, mas não há outra instância para afetar |
| P1-4 / S5 / C2 / C3 DB | **resolvido** | `DB_SSL_MODE` (explícito em produção), CA, pool, `statement_timeout` da API, timeouts próprios da migration |
| P1-5 / C1 / S14 NODE_ENV | **resolvido** | imagem com `NODE_ENV=production`; servidor recusa `test`; preflight com ERROR fora de produção |
| P1-6 health | **resolvido** | `/api/v1/live` sem I/O; `/api/v1/ready` (bootstrap, shutdown, lock, DB, migrations; nunca o Agent); `/health` legado mantido |
| P1-7 / G1–G4 shutdown | **resolvido** | coordenador: readiness 503 → workers drenados → sockets com `SHUTDOWN` → lock → DB → HTTP; limite `SHUTDOWN_TIMEOUT_MS` |
| P1-10 migrations | **parcial** | policy forward-only e timeouts próprios; `uuid-ossp` no preflight (sem migration 26); falta a guarda no down de AgentDomainEvents (mitigado pela proibição de revert) |
| M6 `uuid-ossp` | **resolvido** | runtime com `installExtensions: false` (nenhum `CREATE EXTENSION` implícito); o migration runner garante `uuid-ossp` explicitamente antes das migrations (idempotente, `MigrationPrerequisiteError` sem permissão); `/ready` e o preflight só verificam. Sem migration 26. `test/deployment-extensions.e2e-spec.ts` |
| Flake `server-control-agent` "keeps one non-terminal operation…" | **registrado, não alterado** | 1 falha em 19 execuções na 12.2, sob forte contenção local (e2e completo mais `docker build` em paralelo); o teste pressupõe menos de 1 s entre o claim e a execução (janela de entrega de 1 s na suíte, pausa fixa de 400 ms); o HEAD original passou em todas as repetições feitas (4/4). Investigar e calibrar na 12.6 com carga controlada; não aumentar timeout sem medição |
| Flake `game-command-agent` "retries with the same identity…" | **registrado, não alterado** | 1 falha num e2e completo da delta final da 12.2 (tentativa 3 em vez de 2: o ACK timeout de 600 ms da suíte venceu antes da asserção após `pause(200)`); 6/6 isolada logo depois. Mesma classe do anterior (premissa de tempo sob contenção); calibrar na 12.6 |

## 25.3 Status após a 12.3

| Finding | Status | Como |
| --- | --- | --- |
| P1-8 métricas e alertas | **métricas e contrato de alertas prontos**; scraper, dashboards e entrega de alertas pendentes (ambiente) | prom-client com registry próprio, `/api/v1/metrics` protegido, catálogo `skyrim_admin_*` (HTTP, banco, Agent, GameCommand, Server Control, domain events, backlog pelo banco, VIP, realtime, workers, instância); `docs/observability.md` |
| P3-2 logs JSON | **resolvido** (tracing continua fora) | `AppLogger` JSON em produção, requestId e ids como campos, redaction central, request log por template, stack de 5xx no servidor |
| Queries de backlog | **periódicas** | `BacklogCollector`, `METRICS_COLLECTION_INTERVAL_MS`; nenhuma query por scrape nem por request |
| Duração de query do banco | não medida | exigiria interceptar o TypeORM de forma frágil; pool e erros cobrem saturação |

## 26. Roadmap final da Stage 12

A ordem sugerida na abertura (multi-instância primeiro) foi **alterada**. Os P0
são de segurança, deploy e backup de uma instância única, e a primeira
produção pode ser instância única com deploy recreate (P0-5). Multi-instância
é P2: necessária para escalar, não para operar. Observabilidade vem antes da
recuperação operacional porque as ações de operador precisam de detecção. A
carga vem depois da multi-instância para medir a topologia final.

| Subetapa | Objetivo | Resolve | Critérios de aceite |
| --- | --- | --- | --- |
| **12.1 Security Hardening + Abuse Controls** | Fechar os riscos de segurança concretos da instância única | P0-1, P0-2, P1-1, P1-2, P1-3, P2-7, S6, S7, S11–S13 | login Staff limitado por IP e username com teste de lockout; `trust proxy` por env com teste do IP efetivo; reuso de refresh revoga a sessão (Staff e Player) com teste; tetos de socket e de HELLO com teste; headers presentes e `/docs` desligado em produção (teste); `npm audit` sem HIGH alcançável |
| **12.2 Deployment, Config, Health + Migration/Backup Runbook** | Deploy reproduzível e recuperável de uma instância | P0-3, P0-4, P0-5, P1-4, P1-5, P1-6, P1-7, P1-10 | imagem de produção construída no CI; migration como passo separado; `/live` e `/ready` com testes (readiness 503 no shutdown e sem depender do Agent); shutdown aguarda o tick em andamento (teste); env de SSL e pool; `NODE_ENV=production` obrigatório; runbook de deploy, rollback e restore escrito; **restore test executado** com RTO medido; singleton documentado e verificado |
| **12.3 Observability + Metrics** | Detectar o que hoje é invisível | P1-8, P3-2 | endpoint de métricas com as séries da §13 (gauges do DB); logs JSON com os ids; alertas definidos para UNCERTAIN, work mais antigo que X, Agent offline, 5xx e pool saturado; teste de que nenhum log contém segredos |
| **12.4 Reliability + Operational Recovery** | Dar ao operador ferramentas seguras e auditadas | P1-9, P2-8 (domínio) | Staff APIs para listar e inspecionar trade/purchase AWAITING, releases, deliveries VIP e receipts REJECTED; ações idempotentes e auditadas com regra explícita de "pode duplicar efeito?"; política de timeout operacional decidida; status de conta Player por API auditada; contrato do Admin Web atualizado; testes de corrida faltantes |
| **12.5 Multi-instance + Distributed Coordination** | Rodar N instâncias sem mudar garantias | P2-1…P2-5, P2-8 (Agent) | ownership de sessão por instância com lease; startup fecha só instâncias mortas; revogação e supersede propagados entre instâncias (teste com dois apps sobre o mesmo DB); DOMAIN_EVENT e ACK revalidam a sessão no DB; orçamento de in-flight recontado sob lock; claim de Server Control condicionado à conexão ativa; wake-ups entre instâncias via LISTEN/NOTIFY; rate limits compartilhados; e2e com duas instâncias provando at-least-once e at-most-once |
| **12.6 Performance + Load + Soak** | Medir a topologia final e fixar limites | P2-6 | cenários da §23 executados com relatório; limiares de rate limit e tetos calibrados a partir das medições; soak de 24 h sem crescimento de memória; SLAs propostos pelo produto com os números medidos |
| **12.7 External Integration Smoke + Final Acceptance + Release** | Validar o que não está no repo e liberar | P0-6, P1-11 | smoke de staging com Host Agent/SKSE reais, Electron, Discord e proxy; checklist de `docs/release-readiness.md` 100% marcado com evidência; tag de release |
