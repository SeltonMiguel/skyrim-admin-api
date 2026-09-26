# Observability (Etapa 12.3)

A aplicação **só expõe sinais**: métricas Prometheus em `/api/v1/metrics` e
logs estruturados em stdout/stderr. Coleta, armazenamento, dashboards e
entrega de alertas ficam num sistema de monitoramento externo, escolhido pelo
operador. Não há tracing distribuído, collector nem integração com vendor.

**Uma réplica** (até a 12.5): cada métrica descreve a única instância; não
há agregação entre processos.

## Audit × log × métrica

| Sinal | Para quê | Exemplos | Não entra |
| --- | --- | --- | --- |
| **Audit** (`audit_logs`, append-only) | ação de negócio ou segurança persistente, consultável pelo Admin Web | login Staff, operações Staff, trade liquidado, reuso de refresh | heartbeats, ticks de worker, hits de rate limit, requests comuns |
| **Log** (stdout/stderr) | diagnóstico operacional de um caso | request concluído, comando despachado, sessão do Agent encerrada, throttling | segredos (redigidos), bodies |
| **Métrica** (`/api/v1/metrics`) | agregação e alerta | taxa de 5xx, backlog, UNCERTAIN, lag de worker | **nenhum id** como label |

## `/api/v1/metrics`

- `METRICS_ENABLED`: default ligado fora de produção, **desligado em produção**. Desligado, a resposta é 404.
- `METRICS_BEARER_TOKEN` (≥ 32 caracteres) é **obrigatório** em produção com métricas ligadas; sem ele o boot falha. O scraper envia `Authorization: Bearer <token>`. A comparação é em tempo constante (sha256). Token errado ou ausente recebe 401 genérico.
- O token nunca é logado: a redaction cobre `Bearer …`.
- Não passa por Staff JWT/RBAC: é superfície operacional, não Admin Web.
- Não entra na readiness. Uma falha do scraper não afeta o backend. `/ready` e `/live` continuam pequenos.
- O scrape não gera métrica HTTP própria nem log de request.

## Arquitetura

- `src/observability/metrics.ts`:
  - `Metrics` com um `Registry` próprio por aplicação (sem o registry global do prom-client);
  - nomes `skyrim_admin_*`; process metrics padrão com o mesmo prefixo;
  - `ALLOWED_LABELS` é a allowlist de labels de enums fechados.
- **Estado em memória** (pool do banco, sessões do Agent, sockets realtime, readiness e lock) é lido na hora do scrape, sem query.
- **Estado persistido** (backlogs) vem de `BacklogCollector`:
  - poucas queries agregadas a cada `METRICS_COLLECTION_INTERVAL_MS` (15 s por padrão);
  - nunca por scrape nem por item;
  - reconstruído do banco após qualquer restart.
- **Contadores e histogramas** são incrementados nos pontos de transição, depois do commit, e zeram no restart (esperado). A série histórica é responsabilidade do sistema de monitoramento.
- **Workers**: `TickDrain` recebe um observer de métricas; o `catch` de cada tick marca a falha. A semântica dos workers não mudou.
- **Custo**: counters e histogramas O(1) por evento; nenhuma query por request. A 12.6 mede o overhead.

## Catálogo de métricas (contrato operacional)

Os nomes são um contrato para a 12.7: não renomear sem motivo.

**Processo e instância**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_process_*`, `skyrim_admin_nodejs_*` (CPU, RSS, heap, event loop lag, GC, handles) | padrão do prom-client | os da biblioteca |
| `skyrim_admin_app_info` | gauge (1) | `version`, `git_sha`, `topology` (de `APP_VERSION`, `GIT_SHA`) |
| `skyrim_admin_start_time_seconds` | gauge | — |
| `skyrim_admin_ready` | gauge | — (bootstrap, sem shutdown, lock; a parte de banco fica no `/ready`) |
| `skyrim_admin_instance_lock_held` | gauge (1, 0; -1 = não exigido) | — |
| `skyrim_admin_shutdown_total` | counter | `phase` = started, completed, timed_out, failed |

**HTTP e banco**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_http_requests_total` | counter | `method`, `route` (template Express, ex. `/api/v1/game-servers/:id`, ou `unmatched`), `status` |
| `skyrim_admin_http_request_duration_seconds` | histogram | idem |
| `skyrim_admin_db_pool_connections` | gauge | `state` = total, idle, waiting |
| `skyrim_admin_db_query_errors_total` | counter | — |
| `skyrim_admin_db_pool_errors_total` | counter | — |

A duração de query do banco não é medida: exigiria interceptar o TypeORM de
forma frágil. O pool e os erros cobrem a saturação; a latência aparece na
duração HTTP e na dos workers.

**Host Agent**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_agent_sessions_active` | gauge | — |
| `skyrim_admin_agent_auth_total` | counter | `outcome` = success, rejected, failed; `reason` (catálogo de falhas de auth / verdict) |
| `skyrim_admin_agent_admission_rejects_total` | counter | `reason` = rate, auth_failures, capacity, busy |
| `skyrim_admin_agent_session_closes_total` | counter | `reason` = close reason do protocolo (SUPERSEDED, HEARTBEAT_TIMEOUT, PROTOCOL_ERROR, RATE_LIMITED, …) |
| `skyrim_admin_agent_disconnects_total` | counter | `reason` = motivo persistido (STALE, SHUTDOWN, CLOSED, REQUESTED, …), só quando gravado |

Sem `gameServerId` como label: a visão por servidor é da Admin API e dos logs.

**GameCommand**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_game_commands_created_total` | counter | `command_type` (catálogo fechado de 32), `actor_type` |
| `skyrim_admin_game_command_dispatch_attempts_total` | counter | `command_type`, `attempt` = first, retry |
| `skyrim_admin_game_command_terminal_total` | counter | `command_type`, `status` = SUCCEEDED, FAILED, TIMEOUT, `error_code` (catálogo fechado, ex. DISPATCH_EXPIRED, ACK_TIMEOUT, EXECUTION_TIMEOUT, EXECUTION_UNCERTAIN; `none`) |
| `skyrim_admin_game_command_result_rejections_total` | counter | `reason` = STALE_ATTEMPT, RESULT_CONFLICT, INACTIVE_SESSION, … |
| `skyrim_admin_game_command_create_to_dispatch_seconds` | histogram | `command_type` |
| `skyrim_admin_game_command_dispatch_to_ack_seconds` | histogram | `command_type` |
| `skyrim_admin_game_command_ack_to_terminal_seconds` | histogram | `command_type`, `status` |
| `skyrim_admin_game_command_duration_seconds` | histogram | `command_type`, `status` |
| `skyrim_admin_game_commands_backlog` | gauge (banco) | `status` = PENDING, DISPATCHED, ACKNOWLEDGED |
| `skyrim_admin_game_commands_oldest_age_seconds` | gauge (banco) | `status` |

Criação é contada no insert, dentro da transação do chamador: uma rollback
posterior (Audit indisponível) pode contar um a mais.

**Server Control**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_server_control_created_total` | counter | `type` |
| `skyrim_admin_server_control_terminal_total` | counter | `type`, `status` = SUCCEEDED, FAILED, UNCERTAIN, `error_code` |
| `skyrim_admin_server_control_uncertain_total` | counter | `type` |
| `skyrim_admin_server_control_duration_seconds` | histogram | `type`, `status` (resultados reportados pelo Agent) |
| `skyrim_admin_server_control_result_rejections_total` | counter | `reason` |
| `skyrim_admin_server_control_operations` | gauge (banco) | `status` = PENDING, DISPATCHED, UNCERTAIN (UNCERTAIN conta só as operações **sem resolução** de operador, 12.4; o histórico está em `server_control_uncertain_total`) |

**Domain events, work, VIP**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_domain_events_total` | counter | `kind` (6 kinds; `unknown` se inválido), `outcome` = applied, duplicate, rejected, rejected_retryable, conflict, server_mismatch, invalid, unavailable |
| `skyrim_admin_work_sync_requests_total` | counter | `outcome` = ok, invalid, unavailable |
| `skyrim_admin_work_backlog` | gauge (banco) | `work` = trade_settlement, marketplace_custody, marketplace_settlement, marketplace_release, marketplace_release_failed |
| `skyrim_admin_work_oldest_age_seconds` | gauge (banco) | `work` |
| `skyrim_admin_vip_deliveries` | gauge (banco) | `status` = PENDING, COMMAND_CREATED, SUCCEEDED, FAILED, UNCERTAIN, CANCELLED |
| `skyrim_admin_vip_delivery_oldest_open_age_seconds` | gauge (banco) | — |
| `skyrim_admin_backlog_collection_timestamp_seconds` | gauge | — |
| `skyrim_admin_backlog_collection_errors_total` | counter | — |

Estados reais usados em `work`:
- trade `AWAITING_GAME_CONFIRMATION`, com a idade contada desde `locked_at`;
- listing `PENDING_CUSTODY`;
- purchase `AWAITING_GAME_CONFIRMATION`;
- release `PENDING` e `FAILED` (desde a 12.4, `marketplace_release_failed`
  conta só as releases FAILED **sem resolução** de operador).

**Recuperação operacional** (12.4, `docs/operational-recovery.md`)

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_operator_actions_total` | counter | `domain` = server_control, player_trade, marketplace_custody, marketplace_settlement, marketplace_release, vip_delivery, player_account, player_economy, player_chat; `action` = retry_safe, requeue_same_work, acknowledge, resolve_succeeded, resolve_failed, set_status, adjust, hide; `outcome` = applied, replayed, rejected, rate_limited |
| `skyrim_admin_recovery_unresolved` | gauge (banco) | `domain` = server_control (UNCERTAIN), vip_delivery (FAILED + UNCERTAIN), marketplace_release (FAILED); só itens sem resolução |
| `skyrim_admin_recovery_resolved` | gauge (banco) | `domain` (itens com resolução ainda nas tabelas; cumulativo) |
| `skyrim_admin_recovery_oldest_unresolved_age_seconds` | gauge (banco) | `domain` (desde o `completed_at` do item) |

VIP FAILED recuperado aparece como
`operator_actions_total{domain="vip_delivery",action="retry_safe",outcome="applied"}`;
o gauge `vip_deliveries{status}` continua o estado bruto das linhas.

**Realtime**

| Métrica | Tipo | Labels |
| --- | --- | --- |
| `skyrim_admin_realtime_connections` | gauge | `surface` = player, staff |
| `skyrim_admin_realtime_rejects_total` | counter | `reason` = origin, rate, capacity, auth_failed, auth_timeout, protocol, identity_limit, session_revoked, account_disabled (12.4) |
| `skyrim_admin_realtime_slow_client_drops_total` | counter | — |
| `skyrim_admin_realtime_events_published_total` | counter | `surface` |
| `skyrim_admin_realtime_delivery_failures_total` | counter | — |

**Workers** (`worker` = game_command, server_control, vip_delivery, agent_work_push, heartbeat_sweep, backlog_collector)

| Métrica | Tipo |
| --- | --- |
| `skyrim_admin_worker_ticks_total{worker, outcome=success/error}` | counter |
| `skyrim_admin_worker_ticks_skipped_total{worker}` | counter (tick anterior ainda rodando) |
| `skyrim_admin_worker_tick_duration_seconds{worker}` | histogram |
| `skyrim_admin_worker_last_success_timestamp_seconds{worker}` | gauge |
| `skyrim_admin_worker_running{worker}` | gauge |

## Cardinalidade

- Nenhum label pode conter id (player, staff, character, command, operation, event, work, gameServer), IP, username ou URL concreta.
- `route` é sempre o template.
- O unitário `src/observability/observability.spec.ts` confere cada label registrado contra a allowlist.
- O e2e `test/observability.e2e-spec.ts` confere que nenhum id criado durante o teste aparece no texto exposto.

## Logs estruturados

- `AppLogger` (`src/observability/app-logger.ts`) escreve **JSON por linha** em produção (`LOG_FORMAT=json`) e uma linha legível fora dela. `LOG_LEVEL` vai de error a verbose.
- Campos: `time`, `level`, `context` (componente), `message`, `requestId` (do `x-request-id`, via AsyncLocalStorage do `RequestContext`), `event` quando houver, e os campos `[chave=valor]` que os componentes já logavam (`commandId`, `operationId`, `eventId`, `workId`, `gameServerId`, `connectionId`, `correlationId`, `deliveryId`…).
- **Request log**: uma linha por request (`event=http_request`) com `method`, `route` (template), `status`, `durationMs`, `ip` (pela política `TRUST_PROXY`), `userAgent` (≤ 128 caracteres) e `requestId`. Sem body e sem query string. As probes logam em debug; 5xx loga em warn.
- **Erros 5xx**: `event=http_unhandled_exception` com `requestId`, a classe da exceção e o stack (redigido) no log do servidor. O cliente recebe o 500 genérico.
- 4xx esperados não geram log de erro. Rate limit e auth continuam no `SecurityLog` (12.1).
- Startup e shutdown: `Lifecycle` (lock) e `Shutdown` (fases).
- CLIs (`migrate`, `preflight`, `bootstrap`) continuam com saída simples e sem segredos.

### Correlação

| Fluxo | Onde procurar |
| --- | --- |
| HTTP | `requestId` em cada linha do request (e no Audit `request_id`) |
| HTTP → GameCommand → Agent | `requestId` no Audit e em `game_commands.request_id`; `commandId` e `correlationId` nos logs de dispatch/ACK/RESULT (`AgentGameGateway`, `AgentCommandAdapter`) |
| Server Control | `operationId` nos logs do dispatcher, worker e adapter; `correlationId` na operação |
| DOMAIN_EVENT e work | `eventId`, `kind`, `workId` nos logs do adapter; `deliveryId` na entrega VIP |

Os ids servem para busca em log, **nunca** como label de métrica.

### Redaction

`src/observability/redaction.ts` é aplicada pelo logger a tudo (mensagem,
campos, objetos aninhados, stack), independentemente do chamador:
- chaves de segredo: password, secret, token, authorization, cookie, challenge, private key, certificate, `ca`, api key, connection string, hash. Identificadores terminados em `Id` são mantidos: `credentialId` não é segredo;
- valores: JWT, `Bearer`/`Basic …`, blocos PEM, `usuario:senha@` em URLs e pares `…token=…` em texto.

Testado em `src/observability/observability.spec.ts`. O e2e confere que token de métricas, senha, access token e segredo do Agent não aparecem em nenhum log nem na saída de métricas.

## Alertas recomendados

Os thresholds que dependem de carga ficam como `THRESHOLD_TO_BE_CALIBRATED_12_6`.

| Alerta | Expressão (PromQL ilustrativa) | Threshold |
| --- | --- | --- |
| Backend not ready | probe `/api/v1/ready` ≠ 200, ou `skyrim_admin_ready == 0` | > 1 min |
| Restart repetido | `changes(skyrim_admin_start_time_seconds[30m]) > N` | N = THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Falha de conexão com o banco | `increase(skyrim_admin_db_pool_errors_total[5m]) > 0`, `rate(skyrim_admin_db_query_errors_total[5m])`, ou `skyrim_admin_db_pool_connections{state="waiting"} > 0` sustentado | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Agent reconnect/stale spike | `increase(skyrim_admin_agent_session_closes_total{reason=~"HEARTBEAT_TIMEOUT\|SUPERSEDED"}[15m])`, `increase(skyrim_admin_agent_disconnects_total{reason="STALE"}[15m])` | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Nenhum Agent conectado | `skyrim_admin_agent_sessions_active == 0` com servidor habilitado | > 5 min (decisão do operador) |
| Backlog de GameCommand crescendo | `deriv(skyrim_admin_game_commands_backlog{status="PENDING"}[15m]) > 0` e `skyrim_admin_game_commands_oldest_age_seconds{status="PENDING"} >` X | X = THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Spike de timeout de GameCommand | `increase(skyrim_admin_game_command_terminal_total{status="TIMEOUT"}[15m])` | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Server Control UNCERTAIN | `increase(skyrim_admin_server_control_uncertain_total[1h]) > 0` ou `skyrim_admin_server_control_operations{status="UNCERTAIN"} > 0` (não resolvidas) | **qualquer ocorrência** |
| Item sem resolução envelhecendo (12.4) | `skyrim_admin_recovery_oldest_unresolved_age_seconds >` X, por `domain` | X = THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Ações de operador recusadas ou limitadas (12.4) | `increase(skyrim_admin_operator_actions_total{outcome=~"rejected\|rate_limited"}[1h])` | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Conflito de domain event | `increase(skyrim_admin_domain_events_total{outcome=~"conflict\|server_mismatch"}[1h]) > 0` | qualquer ocorrência |
| Trade parado | `skyrim_admin_work_oldest_age_seconds{work="trade_settlement"} >` X | X = THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Release de Marketplace FAILED | `skyrim_admin_work_backlog{work="marketplace_release_failed"} > 0` | qualquer ocorrência |
| VIP FAILED/UNCERTAIN | aumento de `skyrim_admin_vip_deliveries{status=~"FAILED\|UNCERTAIN"}`; `skyrim_admin_vip_delivery_oldest_open_age_seconds >` X | X = THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Worker sem sucesso | `time() - skyrim_admin_worker_last_success_timestamp_seconds > 10 × intervalo` | por worker |
| Coleta de backlog parada | `time() - skyrim_admin_backlog_collection_timestamp_seconds > 5 × METRICS_COLLECTION_INTERVAL_MS` | — |
| Spike de slow-client no realtime | `increase(skyrim_admin_realtime_slow_client_drops_total[15m])` | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Taxa de HTTP 5xx | `sum(rate(skyrim_admin_http_requests_total{status=~"5.."}[5m])) / sum(rate(skyrim_admin_http_requests_total[5m]))` | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Degradação de latência | `histogram_quantile(0.95, sum by (le, route) (rate(skyrim_admin_http_request_duration_seconds_bucket[5m])))` | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Pressão de memória | `skyrim_admin_process_resident_memory_bytes`, `skyrim_admin_nodejs_heap_size_used_bytes` perto do limite do container | THRESHOLD_TO_BE_CALIBRATED_12_6 |
| Shutdown com timeout | `increase(skyrim_admin_shutdown_total{phase="timed_out"}[1h]) > 0` | qualquer ocorrência |

## Painéis mínimos

| Painel | Métricas |
| --- | --- |
| Backend Overview | `app_info`, `ready`, `instance_lock_held`, `start_time_seconds`, `http_requests_total` (taxa por status), `http_request_duration_seconds` (p50/p95/p99), `process_resident_memory_bytes`, `nodejs_eventloop_lag_seconds`, `db_pool_connections` |
| Agent / Game Bridge | `agent_sessions_active`, `agent_auth_total`, `agent_admission_rejects_total`, `agent_session_closes_total`, `agent_disconnects_total`, `game_commands_backlog`, `game_commands_oldest_age_seconds`, `game_command_terminal_total`, os quatro histogramas de GameCommand, `game_command_result_rejections_total` |
| Server Control | `server_control_created_total`, `server_control_terminal_total`, `server_control_uncertain_total`, `server_control_operations`, `server_control_duration_seconds`, `server_control_result_rejections_total` |
| Player Economy / Work | `work_backlog`, `work_oldest_age_seconds`, `domain_events_total`, `work_sync_requests_total` |
| VIP Delivery | `vip_deliveries`, `vip_delivery_oldest_open_age_seconds`, `game_command_terminal_total{command_type=~"CHARACTER_.*_GIVE"}` |
| Operations / Recovery (12.4) | `recovery_unresolved`, `recovery_resolved`, `recovery_oldest_unresolved_age_seconds`, `operator_actions_total` por `domain`/`action`/`outcome` |
| Realtime | `realtime_connections`, `realtime_rejects_total`, `realtime_slow_client_drops_total`, `realtime_events_published_total`, `realtime_delivery_failures_total` |
| Workers | `worker_ticks_total`, `worker_tick_duration_seconds`, `worker_last_success_timestamp_seconds`, `worker_running`, `worker_ticks_skipped_total`, `backlog_collection_timestamp_seconds` |

Todos os nomes têm o prefixo `skyrim_admin_`. Os JSONs de dashboard dependem da
ferramenta escolhida pelo operador e não fazem parte do repositório.
