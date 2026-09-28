# Release readiness — Skyrim Admin API

Checklist oficial de release definido na Etapa 12.0. Cada item é verificável e
precisa de evidência anexada (link de CI, relatório, log ou commit) quando for
marcado. Os IDs entre parênteses remetem aos findings de
`docs/hardening-audit.md` §25.

Estado na 12.0: nenhum item de P0/P1 está marcado. Os itens já atendidos pela
Etapa 11 estão marcados com a evidência correspondente.

Plano de aceitação externa, componentes disponíveis e bloqueios (12.7A):
`docs/release-acceptance.md`.

> Backend internal acceptance complete.
> External release acceptance pending.

Registro de aceitação interna da 12.7, com base no estado comprovado informado
pelo responsável: fix do flake de ServerControl aplicado; três execuções
consecutivas do CI no GitHub passaram após o fix, com `quality`, `e2e`,
`migrations` e `docker` GREEN, zero skips e nenhuma nova regressão.
Links/IDs das execuções não foram fornecidos neste registro.

A aceitação interna está DONE; a 12.7C aguarda ambiente externo. Stage 12 e
release inteira permanecem pendentes. Continuam **OPEN/EXTERNAL**: Agent/SKSE
real, Electron/Launcher, Discord real, proxy/TLS/CORS/Origins, staging, clock
sync nos hosts reais, monitoring/alert delivery, orchestrator, RPO/RTO/retention,
soak longo, production capacity/SLA e registry (sem destino informado).

Regras:
- A **primeira produção** (instância única) exige todos os itens P0 marcados.
- O **release público** exige todos os P0 e P1.
- A **escala horizontal** (mais de uma réplica) exige também a seção Multi-instance completa.

## Correctness

- [x] Suíte unitária verde, zero skips (647 testes na 12.0; `npm test`)
- [x] Suíte e2e contra PostgreSQL real verde, zero skips (787 testes na 12.0; `TEST_DATABASE_INTEGRATION=true npm run test:e2e`)
- [x] `npm run lint`, `npm run build`, `npx tsc --noEmit --incremental false` e `git diff --check` limpos
- [x] GameCommand at-least-once com dedup por commandId provado e2e (`test/game-command-agent.e2e-spec.ts`, `test/stage11-integration.e2e-spec.ts`)
- [x] Server Control at-most-once e UNCERTAIN provados e2e, inclusive após restart real do backend (`test/stage11-integration.e2e-spec.ts`)
- [x] DOMAIN_EVENT com receipt atômico e retry idempotente provado e2e (`test/agent-domain-events.e2e-spec.ts`)
- [x] Testes de corrida faltantes adicionados: accept duplo de trade, accept contra updateOffer, heartbeat contra updateRuntime, VIP advance contra revoke, mesmo eventId de TRADE_SETTLEMENT/MARKETPLACE_RELEASE em paralelo (P2-8) — accept duplo e accept × edição: `test/player-trades.e2e-spec.ts`; 12.7B: heartbeat × updateRuntime (`test/game-agent.e2e-spec.ts`), advance × revoke e eventId concorrente via socket + serviço (`test/agent-domain-events.e2e-spec.ts`), criar grupo × aceitar convite (`test/player-groups.e2e-spec.ts`), todos com PostgreSQL real
- [x] Nenhum 23505 conhecido mapeado para 500 (F-DB4, F-DB7) — 12.7B: grupos mapeiam os três índices únicos para 409 (`src/player-groups/player-groups.spec.ts`); o filtro global responde 409 genérico a um 23505 não mapeado, sem constraint/SQL na resposta e com log `http_unique_conflict` no servidor (`src/common/filters/http-exception.filter.spec.ts`)

## Security

Controles descritos em `docs/security.md` (12.1).


- [x] Login Staff com rate limit por IP e por username e lockout temporário, coberto por teste e2e (P0-1) — 12.1, `test/security.e2e-spec.ts`
- [x] Hashing de senha com concorrência limitada: N logins paralelos não excedem o orçamento de memória definido (P0-1) — 12.1: no máximo `STAFF_LOGIN_MAX_CONCURRENT` (4 × 64 MiB) Argon2 simultâneos, excesso = 429; `test/security.e2e-spec.ts`
- [x] `trust proxy` configurado por env; teste prova que o IP efetivo do rate limit e do Audit é o do cliente atrás do proxy (P0-2) — 12.1, `test/security.e2e-spec.ts`, `test/auth.e2e-spec.ts`, `src/common/net/client-ip.spec.ts`
- [ ] `TRUST_PROXY` do ambiente de produção configurado com os proxies reais e verificado em staging
- [x] Reuso de refresh token (Staff e Player) revoga a sessão e grava Audit, com teste (P1-1) — 12.1, `test/security.e2e-spec.ts`
- [x] Tetos de sockets realtime por IP e por identidade, e limite de HELLO do Agent, com teste (P1-2) — 12.1, `test/security.e2e-spec.ts`; `AUTH_BUSY` em `src/game-agent/game-agent.spec.ts`
- [x] Headers de segurança presentes (`X-Content-Type-Options`, `X-Frame-Options`, CSP `frame-ancestors`, `Referrer-Policy`) e `X-Powered-By` ausente, verificados por teste (P1-3) — 12.1, `test/security.e2e-spec.ts`
- [ ] HSTS ativo em produção (no proxy ou via `SECURITY_HSTS_MAX_AGE_SECONDS`), verificado no ambiente
- [x] `/docs` e `/docs-json` indisponíveis com `NODE_ENV=production`, com teste (P1-3) — 12.1: default desligado em produção (`src/config/environment.spec.ts`), 404 quando desligado (`test/security.e2e-spec.ts`)
- [x] Limite de body HTTP explícito e documentado (P1-3) — 12.1: 100 kB, 413 testado (`test/security.e2e-spec.ts`), `docs/security.md`
- [x] `PermissionGuard` nega por padrão handler Staff sem metadata; teste de fronteira lista toda rota Staff com a sua permissão (S13) — 12.1: fail-closed + validação no startup, `src/rbac/permission-metadata.spec.ts`
- [x] `npm audit --omit=dev` sem HIGH/CRITICAL alcançável; cada exceção justificada por escrito (P2-7) — 12.7B: `@nestjs/platform-express` 12.0.4 (multer 2.4.0); `npm audit` 0 vulnerabilidades; gate `npm audit --omit=dev --audit-level=high` no CI
- [ ] CORS_ORIGINS e REALTIME_ALLOWED_ORIGINS de produção configurados com as origens reais do Admin Web/Electron
- [x] Socket realtime Player é fechado quando o backend revoga a sessão (logout, reuso de refresh), só para aquela sessão (S6) — 12.1, `test/security.e2e-spec.ts`; instância única até a 12.5
- [x] Socket realtime Player é fechado em mudança de status da conta (S6) — 12.4: `POST /api/v1/operations/players/:playerId/status` revoga as sessões e fecha os sockets (`4001 ACCOUNT_DISABLED`), também entre réplicas (12.5); `test/operational-recovery.e2e-spec.ts` "suspends and bans accounts…"
- [ ] Segredos de produção gerados com ≥ 32 bytes aleatórios e guardados fora do repositório e do backup do DB — 12.7B: produção recusa segredo JWT com menos de 43 caracteres ou menos de 10 distintos (S12); geração e guarda continuam responsabilidade do operador

## Reliability

- [x] Graceful shutdown aguarda o tick em andamento dos workers; teste de SIGTERM durante o dispatch mantém at-least-once/at-most-once sem erro de pool no log (P1-7) — 12.2: dreno dos 5 loops em `src/lifecycle/lifecycle.spec.ts` e `src/game-agent/game-agent.spec.ts`; shutdown com Agent, Server Control claimed e GameCommand PENDING em `test/deployment-lifecycle.e2e-spec.ts`; SIGTERM no container (exit 0)
- [x] Readiness vira 503 ao iniciar o shutdown, antes de fechar HTTP e WebSocket (P1-6, P1-7) — 12.2, `test/deployment-readiness.e2e-spec.ts`, `test/deployment-lifecycle.e2e-spec.ts`
- [x] Staff API para listar e inspecionar trades e purchases AWAITING_GAME_CONFIRMATION, releases PENDING/FAILED, VIP deliveries FAILED/UNCERTAIN/PENDING e receipts REJECTED (P1-9) — 12.4: `/api/v1/operations/*` (`src/operations/operations.controller.ts`), `test/operational-recovery.e2e-spec.ts`
- [x] Toda ação de operador é auditada e declara se pode duplicar efeito físico; ações que podem duplicar exigem confirmação explícita (P1-9) — 12.4: Audit SUCCESS/FAILURE + `operator_actions` na mesma transação; matriz de duplicação em `docs/operational-recovery.md` §1; nenhuma ação que possa duplicar efeito é oferecida (retry só `RETRY_SAFE` com prova pré-entrega)
- [x] Política de timeout operacional para work sem resposta do Agent decidida e implementada ou documentada como manual (P1-9) — 12.4: decidido sem auto-fail; `OPERATIONS_STALE_AFTER_MS` só marca `stale`; resolução manual pelos runbooks
- [x] Mudança de status de conta Player por API auditada, sem SQL manual (P1-9) — 12.4, `test/operational-recovery.e2e-spec.ts`
- [x] Procedimento de ajuste econômico compensatório documentado (ledger imutável) — 12.4: `docs/operational-recovery.md` §5.12, `POST /api/v1/operations/economy/adjustments` balanceado, e2e

## Multi-instance

Exigida somente para mais de uma réplica (`BACKEND_TOPOLOGY=MULTI`,
`docs/multi-instance.md`). Topologia SINGLE:

- [x] Réplica única garantida na configuração de deploy (réplicas = 1, estratégia recreate) e documentada no runbook (P0-5) — 12.2: imposta pelo advisory lock de instância única (segunda instância e migration concorrente recusadas; `test/deployment-lifecycle.e2e-spec.ts` e smoke de container); `docs/deployment.md`
- [ ] Orquestrador de produção configurado com réplicas = 1, estratégia recreate e restart automático (LOCK_LOST sai com exit 1)

Topologia MULTI (12.5; evidência: `test/multi-instance.e2e-spec.ts`, réplicas reais sobre um PostgreSQL, sem mock de coordenação, 3 execuções verdes):

- [x] Várias réplicas simultâneas ready, cada uma com `instanceId` próprio; MULTI nunca toma o lock global (config recusa lock + MULTI)
- [x] A reconciliação de startup fecha só sessões sem lease válido: Agent de A continua CONNECTED quando outra réplica sobe (P2-1)
- [x] Supersede e revogação de credencial em uma instância fecham o socket na outra; com o sinal suprimido, heartbeat, DOMAIN_EVENT e RESULT do socket antigo são recusados pelo banco (P2-2)
- [x] DOMAIN_EVENT, WORK_SYNC, COMMAND_ACK/RESULT, SERVER_CONTROL_RESULT, heartbeat e runtime validados no banco (sessão CONNECTED, dona, lease, credencial) (P2-2)
- [x] Orçamento `AGENT_MAX_IN_FLIGHT_COMMANDS` contado sob o lock de `game_servers`; dispatch concorrente de duas réplicas nunca excede o limite (P2-4)
- [x] Claim de Server Control só pela réplica dona da conexão CONNECTED; entrega única; após o claim nunca há reenvio (RESULT tardio aceito ou UNCERTAIN) (P2-4)
- [x] GameCommand criado em B entregue só pelo dono A; failover antes do envio e depois da execução sem reexecução nem tentativa fantasma
- [x] Wake-up realtime Player e Staff entregue entre instâncias; logout/ban com sinal perdido não entrega dado privado; role Staff alterada em B vale em A (P2-3)
- [x] Rate limits compartilhados (login Staff, ações de operador), chaves em SHA-256, reset e expiração; falha do store recusa (fail closed) (P2-5)
- [x] Cap de conexões por conta cluster-wide, com expiração das leases de uma réplica morta
- [x] Workers de A e B sem efeito duplicado (Trade work, VIP delivery); stale de dono morto marcado uma vez, dono vivo nunca
- [x] Shutdown de uma réplica encerra só os Agents e leases dela; as demais seguem ready
- [x] Migration 27 forward-only: banco novo e 26 → 27 com dados preservados, `pending=0`, diff 0/0
- [ ] Rolling deploy entre versões (expand/contract, compatibilidade Agent e binários) — 12.7A: schema e protocolo do Agent inalterados desde a 27; bus ignora kinds desconhecidos com fallback por polling; sem teste de binários misturados, **não declarado seguro** (`docs/release-acceptance.md` §12)
- [ ] PgBouncer/rede de produção validados para a conexão LISTEN (direta ou session pooling)
- [ ] Orquestrador de produção com N réplicas, load balancer e alertas do bus configurados

## Observability

- [x] Endpoint de métricas expõe as séries mínimas de `docs/hardening-audit.md` §13; gauges de estado vêm do DB (P1-8) — 12.3: `/api/v1/metrics`, catálogo em `docs/observability.md`, `test/observability.e2e-spec.ts`
- [x] `/api/v1/metrics` desligado em produção por padrão; ligado exige bearer token (boot falha sem ele), com comparação em tempo constante — 12.3, `src/observability/observability.spec.ts`
- [x] Nenhum id, IP ou username como label de métrica — 12.3: allowlist verificada no unitário; ids criados no e2e ausentes da saída
- [ ] Scraper de produção configurado com o token e retenção das séries definida pelo operador
- [ ] Dashboards dos painéis mínimos de `docs/observability.md` criados na ferramenta escolhida
- [x] Contrato de alertas documentado (expressões e thresholds `THRESHOLD_TO_BE_CALIBRATED_12_6`) — 12.3, `docs/observability.md`
- [ ] Alertas configurados e disparados em teste para: Server Control UNCERTAIN novo, VIP delivery UNCERTAIN/FAILED, work de Trade/Marketplace/release mais antigo que o limiar, nenhum Agent conectado em servidor habilitado, taxa de 5xx, pool do DB saturado (P1-8) — staging
- [ ] Thresholds calibrados com a carga da 12.6 e entrega de alertas (canal on-call) configurada — baseline local disponível na 12.6 para calibrar; calibração com carga real e entrega on-call ficam para staging
- [x] Logs em JSON com `requestId`, `gameServerId`, `commandId`, `operationId`, `eventId`, `workId` quando aplicáveis (P3-2) — 12.3, `AppLogger`, `test/observability.e2e-spec.ts`
- [ ] Teste de fronteira falha se um log contiver segredo, token, challenge, conteúdo de chat ou payload/result de comando — 12.3 cobre segredo, token, JWT, bearer, PEM, challenge e senha (redaction central + e2e); conteúdo de chat e payload/result de comando continuam protegidos só por não serem logados

## Performance

Evidência local (MEASURED_LOCAL_BASELINE, NOT A PRODUCTION SLA): `docs/performance.md`,
`docs/performance-12.6a-measurements.md`, `docs/performance-12.6b-measurements.md`.

- [x] Cenários de `docs/hardening-audit.md` §23 executados com relatório de p50/p95/p99, throughput e erros (P2-6) — 12.6: baseline e ramp HTTP C=4…32, SINGLE × MULTI, auth, GameCommand, Server Control, DOMAIN_EVENT/WORK_SYNC, economia, realtime, limiter, bus, collector com backlog, overload C=32/128
- [x] Soak misto MULTI com cooldown, sem violação de correctness e sem crescimento ilimitado observado — 12.6B.2: 906 s de workload + 297 s de cooldown; 32 checagens periódicas e final; bus/limiter/leases convergem a 0; heap pós-GC com deriva sublinear
- [ ] Soak de 24 h sem crescimento de memória nem de conexões (P2-6) — **parcial**: 15 min + 37.450 ciclos de churn realtime localmente; horizonte longo fica para staging/produção
- [x] Realtime churn sem retenção: registry, leases (memória e banco) e handles voltam ao baseline — 12.6B.2
- [x] Pool calibrado com evidência: `DB_POOL_MAX=10` mantido (10 → 12 ≈ 4–5%; waiting 1/895 no soak) — 12.6A/12.6B.2
- [x] Margem de leases validada: pior lag de event-loop 17,8 ms (soak) e stalls ≤ 0,8 s contra heartbeat 30 s e lease realtime 60 s; recuperação após crash do owner medida (STALE em 30,5 s) — 12.6B.2
- [x] Cleanup do bus e do limiter validado: zero em ≤ 116 s após a carga, TTL/intervalos inalterados — 12.6B.2
- [x] Latência de polling do Server Control non-owner resolvida por hint (`SERVER_CONTROL_WORK`), polling como fallback — 12.6B.1: commit → owner p99 954 → 11,5 ms
- [x] Latência de polling do GameCommand resolvida por hint (`GAME_COMMAND_WORK`), polling como fallback — 12.6B.2: created → reserved p99 344 → 22 ms
- [x] Flakes históricos de tempo (`server-control-agent` "keeps one non-terminal…", `game-command-agent` "retries with the same identity…") diagnosticados e corrigidos por barreira/estado, sem mudar timeouts — 12.6A; 18/18 + 3 × 56/56 nas repetições
- [x] Contrato de relógio documentado (monotônico local, civil persistido, NTP obrigatório) e 13 casos de step/skew sem falha de correctness — 12.6B.2, `docs/multi-instance.md` §13
- [ ] Limiares de rate limit e tetos de socket definidos a partir das medições e registrados (P2-6) — **parcial**: limites atuais exercitados sem relaxamento; restrição conhecida registrada (Agent 200 frames/10 s ⇒ ~9–10 GameCommands/s por servidor, MEASURED_LOCAL_CAPACITY_CONSTRAINT); validar com o workload real do Agent/SKSE na 12.7
- [ ] SLAs aprovados pelo produto com base nos números medidos (P2-6) — números locais disponíveis; capacidade de produção não medida

## Migrations

- [x] 25 migrations aplicadas, `pending=0`, `synchronize=false`, diff de schema 0/0 (verificado pela suíte e2e na 12.0)
- [x] 26ª migration (`OperationalRecovery`, 12.4) forward-only: banco novo e upgrade 25 → 26 verificados, `pending=0`, diff 0/0; `down` recusa apagar evidência de operador — `test/operational-recovery.e2e-spec.ts`, `test/deployment-readiness.e2e-spec.ts`
- [x] Policy de migration publicada (forward-only, expand/contract, lock/statement timeout, sem `migration:revert` em produção) (P1-10) — 12.2, `docs/deployment.md`
- [x] CLI de migration roda sem o `query_timeout` de 5 s do pool da aplicação (P1-10) — 12.2: `createMigrationOptions` (`DB_MIGRATION_*`), `src/database/database.options.spec.ts`; runner compilado `node dist/database/migrate.js`
- [ ] Down de AgentDomainEvents protegido contra down seguido de up com releases já concluídas (P1-10) — **ACCEPTED_LIMITATION, mitigado por política**: migrations publicadas são imutáveis (não se edita o `down` histórico) e produção é forward-only, sem `migration:revert` (`docs/deployment.md`); rollback de aplicação usa compatibilidade expand/contract, perda de dados usa restore
- [x] Pré-requisito `uuid-ossp`: criado explicitamente só pelo migration runner, nunca pelo runtime (`installExtensions: false`); verificado por `/ready` e pelo preflight (P1-10) — 12.2, sem migration nova, `test/deployment-extensions.e2e-spec.ts`
- [ ] Role de migration de produção com `CREATE` no banco, ou extensão criada por um administrador antes da primeira migration
- [ ] Preflight executado contra o DB de produção antes da primeira migration
- [ ] Smoke pós-migration executado em staging: `migration:show` vazio, contagem de permissions/grants, triggers ALWAYS ativos, readiness 200, login Staff, HELLO de Agent (P1-10) — executado localmente na 12.2 em container descartável (preflight 0 pending, readiness 200, login); staging pendente

## Backups

- [ ] Backup do PostgreSQL de produção configurado (PITR ou dump) com RPO aprovado pelo operador (P0-4) — RPO: PRODUCT/OPS DECISION REQUIRED (`docs/backup-restore.md`); ferramenta: `scripts/db-backup.sh`
- [ ] Política de retenção aprovada (P0-4) — PRODUCT/OPS DECISION REQUIRED
- [x] Restore test executado com sucesso em ambiente isolado, com smoke pós-restore (12.2, local: 26 tabelas críticas iguais à origem, triggers, preflight 0 pending, `/ready` 200 e login no banco restaurado; `docs/backup-restore.md`)
- [ ] Restore test repetido com volume de produção e RTO medido registrado (P0-4) — RTO: PRODUCT/OPS DECISION REQUIRED; 12.7B repetiu o restore real **local** sobre o schema 27 (verify com as tabelas das migrations 26/27, preflight, `/ready`, login), sem valor de RTO
- [ ] Backup verificado imediatamente antes de cada `migration:run` em produção (P0-4, P1-10)
- [x] Procedimento pós-restore para reconciliar efeitos físicos do Agent posteriores ao ponto de restore documentado — `docs/backup-restore.md`

## Deployment

- [x] Imagem de produção reproduzível (multi-stage, `npm ci`, usuário não-root, sem devDependencies, Node 24.18.0 fixado) construída e testada localmente (P0-3) — 12.2, `Dockerfile`, smoke de container
- [x] Imagem construída no CI com tag imutável e smoke do container — **DONE**: job `docker` GREEN nas três execuções consecutivas após o fix; `.github/workflows/ci.yml` constrói `skyrim-admin-api:<commit SHA>` e valida migrate + `/ready` (confirmação do responsável)
- [ ] Publicação da imagem em registry com tag imutável — **OPEN/EXTERNAL**: destino e credenciais de publicação não informados
- [x] Migration como passo de deploy separado do start, sem rebuild (P0-3) — 12.2: `node dist/database/migrate.js` com o lock de instância única; a app nunca migra no start
- [x] `NODE_ENV=production` definido pela imagem e pelo runbook; o servidor recusa `test`; o preflight dá ERROR fora de `production`; produção exige `DB_SSL_MODE` explícito e o lock (P1-5) — 12.2
- [x] SSL para o DB configurável (`DB_SSL_MODE` disable/require/verify-full, CA opcional); pool e timeouts da API e da migration configuráveis (P1-4) — 12.2, `docs/configuration.md`
- [ ] TLS `verify-full` ativo no DB de produção quando ele não é local
- [x] Probes `/api/v1/live` e `/api/v1/ready` implementados; readiness não depende do Agent (P1-6) — 12.2, `test/deployment-readiness.e2e-spec.ts`, smoke de container
- [ ] Probes ligados no orquestrador/proxy de produção
- [ ] Reverse proxy com TLS, upgrade WebSocket em `/api/v1/realtime` e `/api/v1/agent`, timeout de inatividade acima do heartbeat do Agent (P1-11) — contrato em `docs/reverse-proxy.md`; configuração real pendente
- [x] Runbook de deploy, rollback/roll-forward e restore escrito (P0-3) — `docs/deployment.md`, `docs/backup-restore.md`
- [ ] Runbook executado de ponta a ponta em staging
- [ ] Sincronização de relógio (NTP/chrony) verificada em réplicas, hosts dos Agents e PostgreSQL de produção — requisito da 12.6, `docs/multi-instance.md` §13

## External integrations

- [ ] Host Agent real + SKSE em staging: HELLO, heartbeat, GameCommand query e mutation com dedup, Server Control START/PAUSE/RESTART, DOMAIN_EVENT e WORK_SYNC com journal durável, reconexão e restart do Agent (P0-6)
- [ ] Capabilities anunciadas pelo Agent real conferidas contra as executáveis; tempos reais de ACK/RESULT dentro dos timeouts configurados (P0-6)
- [ ] Workload real do Agent/SKSE medido contra o limite de 200 frames/10 s por sessão (~9–10 GameCommands/s por servidor medidos localmente na 12.6)
- [ ] Discord OAuth real em staging com as redirect URIs de produção (P1-11)
- [ ] Electron real contra staging: login, discovery, link, operação, reconnect e cold start (P1-11)
- [ ] Contrato IPC Electron ↔ Launcher validado no repositório externo (P1-11)

## Operations

- [x] Procedimento para cada situação de `docs/hardening-audit.md` §9 documentado (quem, como, riscos de duplicar efeito) — 12.4, `docs/operational-recovery.md` (matriz §1, runbooks §5)
- [x] Recuperação operacional sem SQL manual: Server Control UNCERTAIN resolvido sem retry, requeue do mesmo work, release FAILED com acknowledge/resolução, VIP retry só com prova pré-entrega, status de conta Player, ajuste de GOLD pelo ledger e moderação de chat, todos idempotentes e auditados (P1-9) — 12.4, `test/operational-recovery.e2e-spec.ts`
- [ ] Contrato de claim de alvo para entitlements PLAYER definido pelo produto (12.7)
- [ ] Runbooks de `docs/operational-recovery.md` exercitados em staging com o Agent real
- [ ] Rotação de credencial do Agent (criar B, trocar, revogar A) executada em staging
- [x] Rotação de segredos JWT documentada (efeito: invalida sessões) — 12.7B: `docs/security.md` (um segredo por tipo, sem overlap: manutenção recreate; access-only não força login, refresh força)
- [ ] Bootstrap do coordenador documentado e variáveis `BOOTSTRAP_*` removidas do ambiente após o uso
- [ ] Retenção de logs e do Audit definida conforme LGPD

## Test acceptance

- [x] Primeira execução real do CI no GitHub — **DONE**, verde após o fix do flake de ServerControl (confirmação do responsável)
- [x] Três execuções consecutivas da suíte e2e sem flake em CI — **DONE**, GREEN após o fix, zero skips e nenhuma nova regressão
- [x] Validation/build pipeline — **DONE**: `quality`, `e2e` com `postgres:16`, `migrations` e `docker` GREEN nas três execuções consecutivas confirmadas
- [ ] Versão major do PostgreSQL de produção conferida com a usada no CI (16) — **EXTERNAL**, validação no ambiente real
- [ ] e2e de duas instâncias verde (quando houver escala)
- [x] Relatório de carga/soak anexado — 12.6: `docs/performance.md` e tabelas de medição (local, não SLA)
- [ ] Smoke de staging com integrações reais anexado
- [ ] Este checklist sem itens P0/P1 abertos, com evidência para cada item marcado
