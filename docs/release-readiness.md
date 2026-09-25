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

- [ ] Graceful shutdown aguarda o tick em andamento dos workers; teste de SIGTERM durante o dispatch mantém at-least-once/at-most-once sem erro de pool no log (P1-7)
- [ ] Readiness vira 503 ao iniciar o shutdown, antes de fechar HTTP e WebSocket (P1-6, P1-7)
- [ ] Staff API para listar e inspecionar trades e purchases AWAITING_GAME_CONFIRMATION, releases PENDING/FAILED, VIP deliveries FAILED/UNCERTAIN/PENDING e receipts REJECTED (P1-9)
- [ ] Toda ação de operador é auditada e declara se pode duplicar efeito físico; ações que podem duplicar exigem confirmação explícita (P1-9)
- [ ] Política de timeout operacional para work sem resposta do Agent decidida e implementada ou documentada como manual (P1-9)
- [ ] Mudança de status de conta Player por API auditada, sem SQL manual (P1-9)
- [ ] Procedimento de ajuste econômico compensatório documentado (ledger imutável)

## Multi-instance

Exigida somente para mais de uma réplica. Até lá:

- [ ] Réplica única garantida na configuração de deploy (réplicas = 1, estratégia recreate) e documentada no runbook (P0-5)

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

- [ ] Endpoint de métricas expõe as séries mínimas de `docs/hardening-audit.md` §13; gauges de estado vêm do DB (P1-8)
- [ ] Alertas configurados e disparados em teste para: Server Control UNCERTAIN novo, VIP delivery UNCERTAIN/FAILED, work de Trade/Marketplace/release mais antigo que o limiar, nenhum Agent conectado em servidor habilitado, taxa de 5xx, pool do DB saturado (P1-8)
- [ ] Logs em JSON com `requestId`, `gameServerId`, `commandId`, `operationId`, `eventId`, `workId` quando aplicáveis (P3-2)
- [ ] Teste de fronteira falha se um log contiver segredo, token, challenge, conteúdo de chat ou payload/result de comando

## Performance

- [ ] Cenários de `docs/hardening-audit.md` §23 executados com relatório de p50/p95/p99, throughput e erros (P2-6)
- [ ] Soak de 24 h sem crescimento de memória nem de conexões (P2-6)
- [ ] Limiares de rate limit e tetos de socket definidos a partir das medições e registrados (P2-6)
- [ ] SLAs aprovados pelo produto com base nos números medidos (P2-6)

## Migrations

- [x] 25 migrations aplicadas, `pending=0`, `synchronize=false`, diff de schema 0/0 (verificado pela suíte e2e na 12.0)
- [ ] Policy de migration publicada (forward-only, expand/contract, lock/statement timeout, sem `migration:revert` em produção) (P1-10)
- [ ] CLI de migration roda sem o `query_timeout` de 5 s do pool da aplicação (P1-10)
- [ ] Down de AgentDomainEvents protegido contra down seguido de up com releases já concluídas (P1-10)
- [ ] Pré-requisito `uuid-ossp` documentado e verificado no DB de produção antes da primeira migration (P1-10)
- [ ] Smoke pós-migration executado em staging: `migration:show` vazio, contagem de permissions/grants, triggers ALWAYS ativos, readiness 200, login Staff, HELLO de Agent (P1-10)

## Backups

- [ ] Backup do PostgreSQL de produção configurado (PITR ou dump) com RPO aprovado pelo operador (P0-4)
- [ ] Política de retenção aprovada (P0-4)
- [ ] Restore test executado com sucesso em ambiente isolado, com smoke pós-restore e RTO medido registrado (P0-4)
- [ ] Backup verificado imediatamente antes de cada `migration:run` em produção (P0-4, P1-10)
- [ ] Procedimento pós-restore para reconciliar efeitos físicos do Agent posteriores ao ponto de restore documentado

## Deployment

- [ ] Imagem de produção reproduzível construída no CI (multi-stage, usuário não-root, sem devDependencies, versão de Node fixada) (P0-3)
- [ ] Migration como passo de deploy separado do start, sem rebuild (P0-3)
- [ ] `NODE_ENV=production` obrigatório; boot recusa `test` ou ausência em produção (P1-5)
- [ ] SSL para o DB configurável e ativo quando o DB não é local; pool e timeouts configurados (P1-4)
- [ ] Probes `/health/live` e `/health/ready` implementados e ligados no orquestrador; readiness não depende do Agent (P1-6)
- [ ] Reverse proxy com TLS, upgrade WebSocket em `/api/v1/realtime` e `/api/v1/agent`, timeout de inatividade acima do heartbeat do Agent (P1-11)
- [ ] Runbook de deploy, rollback (restore ou migration corretiva) e restore escrito e executado em staging (P0-3)

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
