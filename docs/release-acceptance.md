# Release acceptance — plano de aceitação externa (12.7A)

Levantamento de 27/09/2026 na branch `feature/skyrim-12-hardening-release`
(HEAD `bdadb6f`, 12.6 commitada). Atualizado na 12.7B (fechamento interno, sem commit): §3
separado em aceitação interna e externa; §10, §11 e §15 revistos. Separa o que este repositório já
prova do que depende de componentes e ambientes que **não estão disponíveis
aqui**. Nada neste documento declara integração validada sem evidência.

Estados: **DONE** (provado por teste/execução com evidência), **PARTIAL**,
**OPEN** (ação no backend/docs ou decisão pendente), **EXTERNAL** (depende de
componente, ambiente ou pessoa fora deste repositório).

## 1. Componentes externos encontrados

Busca feita no workspace Linux (`/home/stooons/www`), no disco Windows
montado (`/mnt/c`, pastas do usuário e Program Files) e no próprio repositório.
Sem CLI do GitHub disponível: outros repositórios remotos não puderam ser
listados; nenhum nome foi presumido.

| Componente | Repo/path | Existe aqui? | Buildável / versão | Executável localmente? | Precisa de humano / Windows / Skyrim | Bloqueia |
| --- | --- | --- | --- | --- | --- | --- |
| Host Agent (C#) | não encontrado | **não** | — | não | Windows + Skyrim/SkyMP | integração completa (P0-6) |
| SKSE Plugin | não encontrado | **não** | — | não | Windows + Skyrim + SKSE | integração completa (P0-6) |
| Electron / C# Launcher | não encontrado | **não** | — | não | desktop Windows | integração Player (P1-11) |
| Admin Web | não encontrado | **não** | — | não | navegador | operação pelo Staff (contrato em `docs/admin-web-integration.md`) |
| Reverse proxy / TLS | nenhuma config deste projeto (os `Caddyfile` em `/home/stooons/www/ec2-demo*` são de outro projeto) | **não** | — | não | domínio + certificado | release pública |
| PgBouncer | nenhuma config | **não** | uso não decidido | — | — | só se for adotado (§6) |
| Monitoring (Prometheus, dashboards, alertas) | nenhuma config | **não** | — | não | canal on-call | operação em produção |
| Deploy / orquestrador | `Dockerfile` (imagem de produção), `docker-compose.yml` (só PostgreSQL de dev) | parcial | imagens locais `skyrim-admin-api:12.2`/`12.3`; sem CI (`.github` ausente), sem registry | imagem sim | ambiente de staging/produção | release (P0-3: imagem no CI) |
| Skyrim / SkyMP / Steam | não instalados neste host | **não** | — | — | — | smoke real |

Consequência: nenhum smoke com Agent, SKSE, Electron, proxy ou monitoramento
reais pode ser executado neste ambiente. A 12.7B depende de alguém fornecer
esses componentes (repos, binários ou um host de staging). O FakeAgent do
repositório já cobre o contrato; não será usado como substituto do Agent real.

## 2. Matriz de compatibilidade de contrato

Contrato do backend = o que o código impõe hoje (fonte). Implementação
externa = nenhuma disponível, portanto **NOT AVAILABLE** em toda a coluna.
A compatibilidade real é verificada na 12.7B, com o componente em mãos.

### Host Agent (WebSocket `/api/v1/agent`, protocolo `1`)

| Contrato do backend | Fonte | Implementação externa | Status |
| --- | --- | --- | --- |
| HELLO como primeiro e único frame; credencial por servidor; `protocolVersion` exatamente `"1"`, senão close 4005 `PROTOCOL_UNSUPPORTED` | `agent-protocol.contracts.ts`, `agent-auth.service.ts` | — | NOT AVAILABLE |
| Runtime: `gameProcessState` (UNKNOWN/STOPPED/STARTING/RUNNING/PAUSED/STOPPING/RESTARTING) + `skseReady`; pronto = RUNNING e SKSE | `agent-protocol.contracts.ts` | — | NOT AVAILABLE |
| HEARTBEAT a cada 10 s; timeout 30 s (close 4008) | `environment.ts` (`AGENT_HEARTBEAT_*`) | — | NOT AVAILABLE |
| COMMAND → COMMAND_ACK → COMMAND_RESULT → COMMAND_RESULT_ACK; retry com mesmo `commandId`/`correlationId`/payload | `game-bridge/command-contract.ts`, `agent-command.adapter.ts` | — | NOT AVAILABLE |
| Journal durável por `commandId` (`COMMAND_DEDUP_V1`) obrigatório para MUTATION; UNCERTAIN quando o efeito não pode ser provado | `agent-capabilities.ts` | — | NOT AVAILABLE |
| SERVER_CONTROL (sem ACK) → SERVER_CONTROL_RESULT; recusa após `notAfter`; journal por `operationId`; nunca executa duas vezes | `agent-capabilities.ts`, `server-control.contracts.ts` | — | NOT AVAILABLE |
| DOMAIN_EVENT com `eventId` idempotente → DOMAIN_EVENT_ACK; `EVENT_CONFLICT`/`DOMAIN_REJECTED` | `agent-domain-event.contracts.ts` | — | NOT AVAILABLE |
| WORK_SYNC → WORK_ITEMS (página ≤ 50 itens e limite de bytes) | `agent-work.service.ts`, `MAX_WORK_PAGE_*` | — | NOT AVAILABLE |
| Shutdown do backend: close 1001 `SHUTDOWN`, Agent reconecta (outra réplica em MULTI) | `agent.gateway.ts` | — | NOT AVAILABLE |
| Supersede (4006), credencial revogada (4009), sessão fechada (4011), server mismatch (4010), AUTH_BUSY (4013) | `AgentClose` | — | NOT AVAILABLE |
| Catálogo fechado de ERROR (`INVALID_MESSAGE`, `UNKNOWN_COMMAND`, `NOT_DISPATCHED`, `RESULT_CONFLICT`, `UNKNOWN_OPERATION`, `OPERATION_MISMATCH`, `EVENT_CONFLICT`, `DOMAIN_REJECTED`, `TEMPORARILY_UNAVAILABLE`, `NOT_IMPLEMENTED`) | `AgentErrorCode` | — | NOT AVAILABLE |
| Frame ≤ 128 KiB (ws fecha com 1009); result ≤ 64 KiB; ≤ 64 capabilities | `MAX_AGENT_FRAME_BYTES` | — | NOT AVAILABLE |
| Capabilities: `GAME_COMMAND_V1`, `COMMAND_DEDUP_V1`, `SERVER_CONTROL_V1` + uma por tipo de comando/ação | `agent-capabilities.ts` | — | NOT AVAILABLE |
| Limite de mensagens 200 por 10 s por sessão (close 4012 `RATE_LIMITED`) | `AGENT_MESSAGE_RATE_LIMIT_*` | — | NOT AVAILABLE (§8) |

### SKSE (fronteira local Agent ↔ plugin)

O backend não fala com o SKSE. O contrato local está descrito em
`docs/game-bridge-protocol.md` e nas capabilities acima (journal, ids,
readiness via `skseReady`). Implementação: NOT AVAILABLE. Nada a comparar no
backend além de `skseReady` e da semântica de COMMAND/RESULT/UNCERTAIN.

### Electron / Launcher

| Contrato do backend | Fonte | Implementação externa | Status |
| --- | --- | --- | --- |
| Auth Player: Discord exchange, refresh com rotação e detecção de reuso, logout | `docs/electron-integration.md` §Auth, `player-auth` | — | NOT AVAILABLE |
| Discovery de game servers e disponibilidade remota (`gameReady` = Agent + RUNNING + SKSE, distinto do processo local) | §GameServer discovery | — | NOT AVAILABLE |
| Character link (challenge confirmado pelo Agent) | `player-characters` | — | NOT AVAILABLE |
| Operações Player e status (`PLAYER_GAME_OPERATION_UPDATED` + GET) | §Contrato HTTP | — | NOT AVAILABLE |
| Realtime Player: AUTH por frame, reconnect + refetch HTTP, sem replay | §Realtime | — | NOT AVAILABLE |
| IPC Electron ↔ C# Launcher | §Electron ↔ C# Launcher (contrato a validar) | — | NOT AVAILABLE |

## 3. Matriz de aceitação

### 3.1 Aceitação INTERNA (provável neste repositório)

Após a 12.7B, tudo o que este repositório consegue provar está DONE ou OPEN
com motivo.

| Teste | Auto/manual | Status | Evidência |
| --- | --- | --- | --- |
| Lint, build, tsc, `git diff --check` | auto | DONE (local) | 12.7B |
| Unit | auto | DONE (local) | 12.7B: 720/720, 47 suítes |
| e2e completo com PostgreSQL 16, 0 skips | auto | DONE (local) | 12.7B (`.perf-results/12.7b/full-2`) |
| `npm audit` sem HIGH/CRITICAL | auto | DONE | 12.7B: 0 vulnerabilidades (multer 2.4.0) |
| Migrations 1–27 em banco novo, `pending=false`, `synchronize=false`, diff 0/0 | auto | DONE (local) | runner de produção + preflight; diff pelas suítes e2e |
| Upgrade 26 → 27 | auto | DONE | `test/multi-instance.e2e-spec.ts` |
| Corridas de domínio e do Agent (P2-8) | auto | DONE | 12.7B, PostgreSQL real |
| 23505 residual nunca vira 500 (F-DB4/F-DB7) | auto | DONE | specs e e2e de grupos, spec do filtro |
| Audit sem texto livre/payload/challenge (S11) | auto | DONE | `metadata-sanitizer.spec.ts` |
| Produção recusa segredo JWT fraco (S12) | auto | DONE | `environment.spec.ts` |
| Restore real sobre schema 27 (backup → banco novo → verify → preflight → `/ready` → login) | manual (script) | DONE (local) | `docs/backup-restore.md` §Restore test 12.7B |
| Imagem Docker com tag do SHA + smoke do container | auto | DONE (local) | `docker build` + migrate + `/ready` + shutdown gracioso |
| Workflow de CI (quality, e2e PG16, migrations, Docker) | auto | OPEN: escrito e validado estaticamente, **nunca executado no GitHub** | `.github/workflows/ci.yml` |
| 3 execuções consecutivas do e2e **em CI** | auto | OPEN | depende da primeira execução do workflow |
| Publicação da imagem em registry com tag imutável | auto | OPEN | não há registry nem credenciais |

### 3.2 Aceitação EXTERNA (depende de componente, ambiente ou decisão)

| Teste | Ambiente | Pré-requisitos | Status | Bloqueia? |
| --- | --- | --- | --- | --- |
| Smoke do Host Agent real (§4) | staging Windows | Agent + SKSE + Skyrim/SkyMP, credencial | EXTERNAL (não disponível) | integração (P0-6) |
| Capacidade real do Agent vs 200 frames/10 s (§8) | staging Windows | Agent real + carga esperada | EXTERNAL | integração |
| Smoke Electron (login, discovery, link, operação, reconnect, cold start) | staging | build Electron + Discord OAuth real | EXTERNAL | integração Player (P1-11) |
| IPC Electron ↔ Launcher | repo externo | Launcher | EXTERNAL | integração Player |
| Discord OAuth com redirect URIs de produção | staging | app Discord | EXTERNAL | integração Player |
| Proxy/TLS, HSTS, WebSocket, `TRUST_PROXY`, Origin, timeouts, limites (§5) | staging | proxy, domínio, certificado | EXTERNAL | release pública |
| CORS e `REALTIME_ALLOWED_ORIGINS` reais | staging | Admin Web/Electron reais | EXTERNAL | release pública |
| Preflight + migration + smoke pós-migration no banco de staging/produção | staging | DB, role com CREATE (ou extensão criada por admin) | EXTERNAL | release |
| Restore com volume real e RTO medido | staging | dump real; RPO/RTO decididos | EXTERNAL + PRODUCT/OPS DECISION | release (P0-4) |
| Sincronização de relógio (§7) | staging/produção | acesso aos hosts | EXTERNAL | release MULTI e Agent |
| Scraper + dashboards + alerta entregue; 14 thresholds calibrados (§9) | staging | stack de monitoramento | EXTERNAL | operação |
| Orquestrador (SINGLE réplicas=1 ou MULTI com LB, probes, LISTEN) | staging | orquestrador escolhido | EXTERNAL | release |
| PgBouncer (só se adotado) | staging | decisão de uso | EXTERNAL/condicional | só se adotado |
| Runbooks de operação e rotação de credencial com Agent real | staging | Agent real | EXTERNAL | operação |
| Deploy/rollback do runbook de ponta a ponta | staging | ambiente | EXTERNAL | release |
| Soak de horizonte longo / SLA de produção | staging/produção | carga real | EXTERNAL + PRODUCT | não para merge |

## 4. Smoke mínimo do Host Agent real (quando disponível)

Pré-requisitos a confirmar com o dono do Agent: repositório/commit, SDK .NET,
Windows com Skyrim + SKSE + SkyMP, credencial criada por
`POST /api/v1/admin/game-servers/:id/agent-credentials`, URL `wss://…/api/v1/agent`.

1. Conectar e autenticar (HELLO): AUTHENTICATED; `protocolVersion` e runtime
   visíveis na API admin do servidor. A API **não** expõe capabilities (por
   desenho): conferir as anunciadas pelo lado do Agent e pela ausência de
   `Game command held: Agent capability missing` nos logs.
2. Runtime: STOPPED/SKSE false → comando fica retido (nenhuma tentativa
   consumida); RUNNING + SKSE → despacha.
3. GameCommand query e mutation: ACK < 5 s, RESULT < 30 s; tempos reais
   registrados.
4. Reconexão com comando em voo: mesma identidade na tentativa seguinte, journal
   não reexecuta (efeito único verificado no jogo).
5. Server Control START/PAUSE/RESTART: execução única; resultado; `notAfter`
   respeitado.
6. DOMAIN_EVENT e WORK_SYNC com journal durável; retry idempotente.
7. Restart do Agent e shutdown do backend (1001): reconexão e retomada.
8. Medir frames/s por sessão no workload real (§8).

Sem Agent real: **EXTERNAL BLOCKER / UNVALIDATED**.

## 5. Proxy/TLS — checklist executável

Contrato: `docs/reverse-proxy.md`. No ambiente real, verificar:

- `curl -I https://<host>/api/v1/ready` → 200; HTTP → HTTPS; header HSTS presente.
- Upgrade WebSocket em `/api/v1/agent` e `/api/v1/realtime` (ex.: `websocat`),
  com `Origin` preservado; query string recusada.
- Login Staff por trás do proxy: `staff_sessions.ip_address` e
  `audit_logs.ip_address` com o IP real (valida `TRUST_PROXY`).
- `X-Request-Id` devolvido; logs com o mesmo `requestId`.
- Idle timeout do proxy > 10 s (heartbeat do Agent) e ≥ 60 s no realtime;
  read timeout > 10 s (`DB_STATEMENT_TIMEOUT_MS`).
- Limites do proxy ≥ body 100 kB, frame 16 KiB (realtime) e 128 KiB (Agent);
  sem buffering de WebSocket; sem cache de `/api/v1/*`.
- LB: `/api/v1/ready` para tráfego, `/api/v1/live` para o processo.

## 6. PgBouncer

Uso **não decidido** (nenhuma config ou menção de adoção). Não bloqueia a
release enquanto não for adotado. Se for: o pool da aplicação pode usar
transaction pooling; a conexão LISTEN de cada réplica MULTI precisa de conexão
direta ao PostgreSQL ou session pooling; o advisory lock SINGLE também exige
sessão (conexão direta). Validar em staging antes de ligar.

## 7. Sincronização de relógio — verificação operacional

Requisito da 12.6 (`docs/multi-instance.md` §13). Não há limite numérico
validado; o critério é "sem skew grosseiro" e sincronização ativa.

- Linux (réplicas e PostgreSQL): `timedatectl show -p NTPSynchronized` = `yes`;
  `chronyc tracking` (offset e estado) ou equivalente.
- Windows (host do Agent): `w32tm /query /status` (fonte e última
  sincronização) e `w32tm /stripchart /computer:<servidor NTP> /samples:5`.
- Entre app e banco: comparar `SELECT now()` com o relógio do host da réplica.
- Recomendação operacional: alertar pela ferramenta do host (ex.: exporter do
  sistema com o estado de sincronização). O backend não expõe métrica de skew.

## 8. Capacidade do Agent — plano de medição real

MEASURED_LOCAL_CAPACITY_CONSTRAINT (12.6): 200 frames por 10 s por sessão;
~2 frames por GameCommand (ACK + RESULT); teto local ~9–10 GameCommands/s por
servidor. Com o Agent real, medir em staging:

- GameCommands/s esperados no pico por servidor (pelo produto);
- frames de ACK/RESULT, HEARTBEAT, runtime, DOMAIN_EVENT e WORK_SYNC por
  segundo, pelo lado do backend (`skyrim_admin_domain_events_total`,
  `work_sync_requests_total`, contagem por sessão no teste);
- se o workload esperado cabe no limite com margem.

O limite (`AGENT_MESSAGE_RATE_LIMIT_COUNT`/`_WINDOW_MS`) não muda antes dessa
evidência.

## 9. Observabilidade externa

- **Contrato de métricas: DONE** (12.3, `test/observability.e2e-spec.ts`).
- **Pipeline real: EXTERNAL** — nenhum Prometheus, dashboard ou entrega de
  alerta neste ambiente.
- Alertas (`docs/observability.md`): 24 definidos; 10 estruturalmente prontos
  (condição zero/booleana: not ready, nenhum Agent, UNCERTAIN, conflito de
  domain event, release FAILED, bus fora, rate limit falhando, worker sem
  sucesso, coleta parada, shutdown com timeout); **14 com threshold pendente
  de calibração em produção** (`THRESHOLD_TO_BE_CALIBRATED_12_6`: restart,
  banco, Agent reconnect/stale, backlog e timeout de GameCommand, item sem
  resolução, ações de operador recusadas, trade parado, VIP, ownership perdido,
  slow-client, 5xx, latência, memória). A baseline local da 12.6 orienta, não
  define.

## 10. Backup/restore

- Scripts (`scripts/db-backup.sh`, `scripts/db-restore-verify.sh`) fazem dump
  e restore do banco inteiro.
- 12.7B: o verify passou a conferir 29 tabelas críticas (inclui
  `operator_actions`, `vip_reward_delivery_attempts`, `agent_work_rejections`)
  e, da migration 27, só o schema: as tabelas efêmeras de coordenação
  (`distributed_bus_events`, `rate_limit_buckets`, `rate_limit_slots`,
  `realtime_connection_leases`) são estado reconstruível e não têm contagem
  comparada; `game_connections.owner_instance_id` (dado persistido da sessão),
  índices e constraints são verificados.
- Restore real local sobre a 27 executado (ver `docs/backup-restore.md`).
- RPO, RTO, retenção e local/cifragem: **PRODUCT/OPS DECISION REQUIRED**.

## 11. Dependências — multer

Resolvido na 12.7B com a opção A: `@nestjs/platform-express` 12.0.1 → 12.0.4
(patch; peers `^12.0.0`), multer 2.2.0 → 2.4.0; 2 pacotes alterados e 5
removidos; express inalterado (5.2.1); só `ExpressAdapter` é usado.
`npm audit`: 2 HIGH → 0. Unit e e2e completos verdes depois do patch.

## 12. Compatibilidade entre binários (rolling)

Desde a migration 27 (`0523e16`) não mudaram migrations, protocolo do Agent,
capabilities, contratos de Server Control nem eventos realtime. As mudanças de
produção da 12.6 são internas (hints e janela monotônica).

- Binário antigo (`8b291c8`, antes da 12.6) + schema 27 e binário novo (`bdadb6f`) + schema 27: mesmo
  schema, sem migration nova. Compatíveis no schema.
- **Bus:** o CHECK de `distributed_bus_events.kind` é uma regex, então aceita
  os kinds novos. Um subscriber antigo recebendo `SERVER_CONTROL_WORK` ou
  `GAME_COMMAND_WORK` só incrementa `cluster_bus_messages_total{outcome="received"}`
  (counter sem validação de rótulo) e não encontra handler: ignora, sem
  derrubar o listener (handlers também ficam em try/catch). Um publisher antigo
  não emite hints: o owner novo cai no polling (1 s / 500 ms). Nos dois
  sentidos a correctness depende só do banco.
- SINGLE não faz rolling (advisory lock exclui a segunda instância).
- **Rolling continua não declarado seguro**: não houve teste com binários
  misturados, e o procedimento de deploy (recreate) não mudou.

## 13. Versionamento do protocolo do Agent

- Versão única `"1"`, sem negociação nem fallback. Backend novo aceita Agent
  antigo **se** este falar a versão 1; qualquer outra versão fecha com 4005
  `PROTOCOL_UNSUPPORTED` (falha fechada, motivo explícito no close).
- Features por capability: tipos de comando, dedup obrigatório para MUTATION,
  Server Control por ação. Sem a capability, o comando fica retido sem consumir
  tentativa e o backend loga `Game command held: Agent capability missing` uma
  vez por comando; Server Control sem Agent elegível (sessão ou capability)
  fica `HELD`, logado uma vez, e termina FAILED/`DISPATCH_EXPIRED` no pending
  timeout, sem nunca ser enviado.
- Agent novo contra backend antigo: depende do Agent; o backend deste repo não
  anuncia versão além de responder com `protocolVersion` no AUTHENTICATED.
- Mensagem ao operador: logs acima e `protocolVersion`/runtime na API admin do
  servidor (capabilities não são expostas); não há métrica dedicada de
  incompatibilidade.

## 14. Topologias candidatas

| Topologia | Aplicação | Produção |
| --- | --- | --- |
| SINGLE (recreate, advisory lock) | SUPPORTED (12.2) | falta orquestrador com réplicas = 1 e restart automático configurado |
| MULTI (N réplicas + PostgreSQL + LB, sem sticky) | SUPPORTED (12.5, medido na 12.6) | orquestrador, LB, probes, LISTEN e relógio não validados; não exige Kubernetes |

## 15. Bloqueios

### A. Bloqueios do backend (antes de merge/release)

Nenhum bloqueio funcional conhecido. Pendências internas restantes, todas de
processo:

1. Primeira execução verde do workflow de CI no GitHub (e três e2e
   consecutivos lá).
2. Registry para publicar a imagem com tag imutável (hoje só build e smoke).

### B. Bloqueios de aceitação externa (backend pode estar pronto; release integrada não)

1. Host Agent real + SKSE: smoke da §4 e capacidade da §8 (P0-6).
2. Electron/Launcher + Discord OAuth reais (P1-11).
3. Proxy/TLS reais com HSTS, WebSocket, `TRUST_PROXY`, CORS/Origins (§5).
4. Staging: preflight, migration, smoke pós-migration, runbook de
   deploy/rollback, restore com volume real.
5. RPO, RTO, retenção e local/cifragem dos backups: PRODUCT/OPS DECISION
   REQUIRED (P0-4).
6. Relógio sincronizado verificado nos hosts reais (§7).
7. Monitoramento real: scraper, dashboards, entrega de alertas, thresholds.
8. Segredos de produção gerados e guardados fora do repo/backup. **BREAKING_CONFIG
   (S12)**: o boot de produção recusa segredo JWT com menos de 43 caracteres ou
   menos de 10 distintos; trocar antes da primeira release com a regra
   (`docs/security.md`).
9. Orquestrador de produção configurado para a topologia escolhida.

### C. Limitações conhecidas / follow-up (não bloqueiam se aceitas)

1. Teto de ~9–10 GameCommands/s por servidor pelo limite de mensagens do Agent
   (validar na B.1).
2. Soak local de 15 min; horizonte longo só em staging/produção.
3. 14 thresholds de alerta a calibrar com dados reais.
4. Rolling deploy entre versões não declarado seguro (recreate obrigatório).
5. PgBouncer não validado (só relevante se adotado).
6. Rotação de segredos JWT sem overlap de chaves: exige manutenção recreate.
7. S12 é um piso heurístico (tamanho e caracteres distintos), não medida de
   entropia.
8. Timestamps entre réplicas não ordenam causalidade sob skew.
9. Entitlements PLAYER: PRODUCT CONTRACT REQUIRED (nenhuma rota de claim; o
   grant cria o direito sem entregas e nunca escolhe personagem).
10. Reautorização Staff por evento sem cache: custo, não correctness; sem
    gargalo medido.
11. `down` histórico de AgentDomainEvents (M4) não ganha guarda em código:
    migrations publicadas são imutáveis; a proteção é a política forward-only
    (sem `migration:revert` em produção).
