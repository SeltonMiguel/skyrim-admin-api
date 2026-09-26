# Release readiness — Skyrim Admin API

Checklist oficial de release definido na Etapa 12.0. Cada item é verificável e
precisa de evidência anexada (link de CI, relatório, log ou commit) quando for
marcado. Os IDs entre parênteses remetem aos findings de
`docs/hardening-audit.md` §25.

Estado na 12.0: nenhum item de P0/P1 está marcado. Os itens já atendidos pela
Etapa 11 estão marcados com a evidência correspondente.

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
- [ ] Testes de corrida faltantes adicionados: accept duplo de trade, accept contra updateOffer, heartbeat contra updateRuntime, VIP advance contra revoke, mesmo eventId de TRADE_SETTLEMENT/MARKETPLACE_RELEASE em paralelo (P2-8)
- [ ] Nenhum 23505 conhecido mapeado para 500 (F-DB4, F-DB7)

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
- [ ] `npm audit --omit=dev` sem HIGH/CRITICAL alcançável; cada exceção justificada por escrito (P2-7) — multer (não alcançável) justificado em `docs/security.md`; upgrade proposto, não aplicado
- [ ] CORS_ORIGINS e REALTIME_ALLOWED_ORIGINS de produção configurados com as origens reais do Admin Web/Electron
- [x] Socket realtime Player é fechado quando o backend revoga a sessão (logout, reuso de refresh), só para aquela sessão (S6) — 12.1, `test/security.e2e-spec.ts`; instância única até a 12.5
- [ ] Socket realtime Player é fechado em mudança de status da conta (S6) — sem mutation de backend hoje (só SQL); fica para a API de status da 12.4
- [ ] Segredos de produção gerados com ≥ 32 bytes aleatórios e guardados fora do repositório e do backup do DB

## Reliability

- [x] Graceful shutdown aguarda o tick em andamento dos workers; teste de SIGTERM durante o dispatch mantém at-least-once/at-most-once sem erro de pool no log (P1-7) — 12.2: dreno dos 5 loops em `src/lifecycle/lifecycle.spec.ts` e `src/game-agent/game-agent.spec.ts`; shutdown com Agent, Server Control claimed e GameCommand PENDING em `test/deployment-lifecycle.e2e-spec.ts`; SIGTERM no container (exit 0)
- [x] Readiness vira 503 ao iniciar o shutdown, antes de fechar HTTP e WebSocket (P1-6, P1-7) — 12.2, `test/deployment-readiness.e2e-spec.ts`, `test/deployment-lifecycle.e2e-spec.ts`
- [ ] Staff API para listar e inspecionar trades e purchases AWAITING_GAME_CONFIRMATION, releases PENDING/FAILED, VIP deliveries FAILED/UNCERTAIN/PENDING e receipts REJECTED (P1-9)
- [ ] Toda ação de operador é auditada e declara se pode duplicar efeito físico; ações que podem duplicar exigem confirmação explícita (P1-9)
- [ ] Política de timeout operacional para work sem resposta do Agent decidida e implementada ou documentada como manual (P1-9)
- [ ] Mudança de status de conta Player por API auditada, sem SQL manual (P1-9)
- [ ] Procedimento de ajuste econômico compensatório documentado (ledger imutável)

## Multi-instance

Exigida somente para mais de uma réplica. Até lá:

- [x] Réplica única garantida na configuração de deploy (réplicas = 1, estratégia recreate) e documentada no runbook (P0-5) — 12.2: imposta pelo advisory lock de instância única (segunda instância e migration concorrente recusadas; `test/deployment-lifecycle.e2e-spec.ts` e smoke de container); `docs/deployment.md`
- [ ] Orquestrador de produção configurado com réplicas = 1, estratégia recreate e restart automático (LOCK_LOST sai com exit 1)

Para escalar:

- [ ] A reconciliação de startup fecha só sessões de instâncias sem lease válido; teste com dois apps sobre o mesmo DB (P2-1)
- [ ] Revogação de credencial e supersede em uma instância fecham o socket na outra; teste e2e com duas instâncias (P2-2)
- [ ] DOMAIN_EVENT, WORK_SYNC e COMMAND_ACK revalidam no DB que a sessão ainda está ativa (P2-2)
- [ ] Orçamento `AGENT_MAX_IN_FLIGHT_COMMANDS` recontado sob o lock de `game_servers`; teste com dois workers (P2-4)
- [ ] Claim de Server Control só vence para a conexão CONNECTED no DB; teste com sessão obsoleta em outra instância (P2-4)
- [ ] Wake-up realtime Player e Staff entregue entre instâncias; teste e2e mutation em B → evento no socket em A (P2-3)
- [ ] Rate limits compartilhados entre instâncias, com teste (P2-5)
- [ ] e2e com duas instâncias reproduzindo a matriz de reconnect da 11.6 sem regressão de garantias

## Observability

- [x] Endpoint de métricas expõe as séries mínimas de `docs/hardening-audit.md` §13; gauges de estado vêm do DB (P1-8) — 12.3: `/api/v1/metrics`, catálogo em `docs/observability.md`, `test/observability.e2e-spec.ts`
- [x] `/api/v1/metrics` desligado em produção por padrão; ligado exige bearer token (boot falha sem ele), com comparação em tempo constante — 12.3, `src/observability/observability.spec.ts`
- [x] Nenhum id, IP ou username como label de métrica — 12.3: allowlist verificada no unitário; ids criados no e2e ausentes da saída
- [ ] Scraper de produção configurado com o token e retenção das séries definida pelo operador
- [ ] Dashboards dos painéis mínimos de `docs/observability.md` criados na ferramenta escolhida
- [x] Contrato de alertas documentado (expressões e thresholds `THRESHOLD_TO_BE_CALIBRATED_12_6`) — 12.3, `docs/observability.md`
- [ ] Alertas configurados e disparados em teste para: Server Control UNCERTAIN novo, VIP delivery UNCERTAIN/FAILED, work de Trade/Marketplace/release mais antigo que o limiar, nenhum Agent conectado em servidor habilitado, taxa de 5xx, pool do DB saturado (P1-8) — staging
- [ ] Thresholds calibrados com a carga da 12.6 e entrega de alertas (canal on-call) configurada
- [x] Logs em JSON com `requestId`, `gameServerId`, `commandId`, `operationId`, `eventId`, `workId` quando aplicáveis (P3-2) — 12.3, `AppLogger`, `test/observability.e2e-spec.ts`
- [ ] Teste de fronteira falha se um log contiver segredo, token, challenge, conteúdo de chat ou payload/result de comando — 12.3 cobre segredo, token, JWT, bearer, PEM, challenge e senha (redaction central + e2e); conteúdo de chat e payload/result de comando continuam protegidos só por não serem logados

## Performance

- [ ] Cenários de `docs/hardening-audit.md` §23 executados com relatório de p50/p95/p99, throughput e erros (P2-6)
- [ ] Soak de 24 h sem crescimento de memória nem de conexões (P2-6)
- [ ] Limiares de rate limit e tetos de socket definidos a partir das medições e registrados (P2-6)
- [ ] SLAs aprovados pelo produto com base nos números medidos (P2-6)

## Migrations

- [x] 25 migrations aplicadas, `pending=0`, `synchronize=false`, diff de schema 0/0 (verificado pela suíte e2e na 12.0)
- [x] Policy de migration publicada (forward-only, expand/contract, lock/statement timeout, sem `migration:revert` em produção) (P1-10) — 12.2, `docs/deployment.md`
- [x] CLI de migration roda sem o `query_timeout` de 5 s do pool da aplicação (P1-10) — 12.2: `createMigrationOptions` (`DB_MIGRATION_*`), `src/database/database.options.spec.ts`; runner compilado `node dist/database/migrate.js`
- [ ] Down de AgentDomainEvents protegido contra down seguido de up com releases já concluídas (P1-10) — sem guarda em código; a policy da 12.2 proíbe `migration:revert` em produção
- [x] Pré-requisito `uuid-ossp`: criado explicitamente só pelo migration runner, nunca pelo runtime (`installExtensions: false`); verificado por `/ready` e pelo preflight (P1-10) — 12.2, sem migration nova, `test/deployment-extensions.e2e-spec.ts`
- [ ] Role de migration de produção com `CREATE` no banco, ou extensão criada por um administrador antes da primeira migration
- [ ] Preflight executado contra o DB de produção antes da primeira migration
- [ ] Smoke pós-migration executado em staging: `migration:show` vazio, contagem de permissions/grants, triggers ALWAYS ativos, readiness 200, login Staff, HELLO de Agent (P1-10) — executado localmente na 12.2 em container descartável (preflight 0 pending, readiness 200, login); staging pendente

## Backups

- [ ] Backup do PostgreSQL de produção configurado (PITR ou dump) com RPO aprovado pelo operador (P0-4) — RPO: TO BE DECIDED (`docs/backup-restore.md`); ferramenta: `scripts/db-backup.sh`
- [ ] Política de retenção aprovada (P0-4) — TO BE DECIDED
- [x] Restore test executado com sucesso em ambiente isolado, com smoke pós-restore (12.2, local: 26 tabelas críticas iguais à origem, triggers, preflight 0 pending, `/ready` 200 e login no banco restaurado; `docs/backup-restore.md`)
- [ ] Restore test repetido com volume de produção e RTO medido registrado (P0-4) — RTO: TO BE DECIDED
- [ ] Backup verificado imediatamente antes de cada `migration:run` em produção (P0-4, P1-10)
- [x] Procedimento pós-restore para reconciliar efeitos físicos do Agent posteriores ao ponto de restore documentado — `docs/backup-restore.md`

## Deployment

- [x] Imagem de produção reproduzível (multi-stage, `npm ci`, usuário não-root, sem devDependencies, Node 24.18.0 fixado) construída e testada localmente (P0-3) — 12.2, `Dockerfile`, smoke de container
- [ ] Imagem construída no CI e publicada com tag imutável
- [x] Migration como passo de deploy separado do start, sem rebuild (P0-3) — 12.2: `node dist/database/migrate.js` com o lock de instância única; a app nunca migra no start
- [x] `NODE_ENV=production` definido pela imagem e pelo runbook; o servidor recusa `test`; o preflight dá ERROR fora de `production`; produção exige `DB_SSL_MODE` explícito e o lock (P1-5) — 12.2
- [x] SSL para o DB configurável (`DB_SSL_MODE` disable/require/verify-full, CA opcional); pool e timeouts da API e da migration configuráveis (P1-4) — 12.2, `docs/configuration.md`
- [ ] TLS `verify-full` ativo no DB de produção quando ele não é local
- [x] Probes `/api/v1/live` e `/api/v1/ready` implementados; readiness não depende do Agent (P1-6) — 12.2, `test/deployment-readiness.e2e-spec.ts`, smoke de container
- [ ] Probes ligados no orquestrador/proxy de produção
- [ ] Reverse proxy com TLS, upgrade WebSocket em `/api/v1/realtime` e `/api/v1/agent`, timeout de inatividade acima do heartbeat do Agent (P1-11) — contrato em `docs/reverse-proxy.md`; configuração real pendente
- [x] Runbook de deploy, rollback/roll-forward e restore escrito (P0-3) — `docs/deployment.md`, `docs/backup-restore.md`
- [ ] Runbook executado de ponta a ponta em staging

## External integrations

- [ ] Host Agent real + SKSE em staging: HELLO, heartbeat, GameCommand query e mutation com dedup, Server Control START/PAUSE/RESTART, DOMAIN_EVENT e WORK_SYNC com journal durável, reconexão e restart do Agent (P0-6)
- [ ] Capabilities anunciadas pelo Agent real conferidas contra as executáveis; tempos reais de ACK/RESULT dentro dos timeouts configurados (P0-6)
- [ ] Discord OAuth real em staging com as redirect URIs de produção (P1-11)
- [ ] Electron real contra staging: login, discovery, link, operação, reconnect e cold start (P1-11)
- [ ] Contrato IPC Electron ↔ Launcher validado no repositório externo (P1-11)

## Operations

- [ ] Procedimento para cada situação de `docs/hardening-audit.md` §9 documentado (quem, como, riscos de duplicar efeito)
- [ ] Rotação de credencial do Agent (criar B, trocar, revogar A) executada em staging
- [ ] Rotação de segredos JWT documentada (efeito: invalida sessões)
- [ ] Bootstrap do coordenador documentado e variáveis `BOOTSTRAP_*` removidas do ambiente após o uso
- [ ] Retenção de logs e do Audit definida conforme LGPD

## Test acceptance

- [ ] Todas as suítes verdes em CI com PostgreSQL da mesma versão major da produção
- [ ] Três execuções consecutivas da suíte e2e sem flake em CI
- [ ] e2e de duas instâncias verde (quando houver escala)
- [ ] Relatório de carga/soak anexado
- [ ] Smoke de staging com integrações reais anexado
- [ ] Este checklist sem itens P0/P1 abertos, com evidência para cada item marcado
