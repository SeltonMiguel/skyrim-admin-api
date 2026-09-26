# Configuration reference

Todas as 92 variáveis de ambiente do backend (`src/config/environment.ts`), na
Etapa 12.2. A validação é feita no boot, por Joi mais as relações entre valores
(`abortEarly: false`). Uma variável inválida impede o start. A mensagem cita
só o **nome** da variável, nunca o valor. O migration runner e o preflight usam
a mesma validação.

**Do not run more than one backend replica before Stage 12.5.**

Classes:
- **REQUIRED_PRODUCTION**: obrigatória, ou com valor explícito obrigatório, em `NODE_ENV=production`.
- **OPTIONAL_SAFE_DEFAULT**: tem default seguro para a réplica única.
- **DEV_ONLY**: só para desenvolvimento ou operação pontual.
- **TEST_ONLY**: só para as suítes.

Unidades: sufixo `_MS` é inteiro em milissegundos. As durações sem sufixo são
strings `N{s,m,h,d}` (ex.: `15m`).

## Processo e implantação

| Variável | Classe | Default | Notas |
| --- | --- | --- | --- |
| `NODE_ENV` | REQUIRED_PRODUCTION | `development` | `production` na imagem e no runbook. O servidor (`dist/main.js`) recusa `test`. Fora de produção loga um aviso |
| `PORT` | OPTIONAL_SAFE_DEFAULT | `3000` | |
| `BACKEND_TOPOLOGY` | OPTIONAL_SAFE_DEFAULT | `SINGLE` | só `SINGLE`; qualquer outro valor falha no boot até a 12.5 |
| `SINGLE_INSTANCE_LOCK_ENABLED` | REQUIRED_PRODUCTION (implícito) | `true` em produção, `false` fora | advisory lock `pg_advisory_lock(1397446994, 1)` numa conexão dedicada; `false` em produção falha no boot |
| `SHUTDOWN_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `8000` | 1000–600000; o stop timeout do orquestrador precisa ser maior (ex.: `docker stop -t 15`) |

## Banco de dados

| Variável | Classe | Default | Notas |
| --- | --- | --- | --- |
| `DB_HOST`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` | REQUIRED_PRODUCTION | — | a senha nunca aparece em logs nem no preflight |
| `DB_PORT` | OPTIONAL_SAFE_DEFAULT | `5432` | |
| `DB_SSL_MODE` | REQUIRED_PRODUCTION | `disable` fora de produção | `disable`, `require` (cifra sem verificar o servidor) ou `verify-full` (CA + hostname). Em produção precisa ser explícito |
| `DB_SSL_CA_FILE` | OPTIONAL | — | caminho de um PEM, só com `verify-full`; um erro cita o nome da variável, nunca o conteúdo |
| `DB_POOL_MAX` | OPTIONAL_SAFE_DEFAULT | `10` | por réplica. Total de conexões = réplicas × `DB_POOL_MAX` + 1 (lock). Hoje réplicas = 1. Calibrar na 12.6 |
| `DB_POOL_IDLE_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `30000` | |
| `DB_CONNECT_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `5000` | |
| `DB_QUERY_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `5000` | timeout do cliente nas queries da API; ≤ `DB_STATEMENT_TIMEOUT_MS` |
| `DB_STATEMENT_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `10000` | `statement_timeout` do servidor para a API (cancela queries fugitivas no PostgreSQL) |
| `DB_MIGRATION_STATEMENT_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `600000` | só o runner de migration e o CLI |
| `DB_MIGRATION_LOCK_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `10000` | DDL nunca espera lock indefinidamente |
| `DB_LOGGING` | OPTIONAL | `true` só em development | nunca registra SQL nem parâmetros |

## Segurança e proxy (12.1, `docs/security.md`)

| Variável | Classe | Default | Notas |
| --- | --- | --- | --- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | REQUIRED_PRODUCTION | — | ≥ 32 caracteres, distintos; use ≥ 32 bytes aleatórios |
| `PLAYER_JWT_ACCESS_SECRET`, `PLAYER_JWT_REFRESH_SECRET` | REQUIRED_PRODUCTION | — | distintos entre si e dos de Staff |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | OPTIONAL_SAFE_DEFAULT | `15m` / `7d` | access ≤ 1 h; refresh ≤ 90 d e maior que access |
| `PLAYER_JWT_ACCESS_TTL` / `PLAYER_JWT_REFRESH_TTL` | OPTIONAL_SAFE_DEFAULT | `15m` / `30d` | |
| `TRUST_PROXY` | REQUIRED_PRODUCTION (decisão) | `false` | `false`, número de hops, ou lista loopback/linklocal/uniquelocal/IP/CIDR; `true` é recusado. Atrás de proxy, configure o proxy real |
| `CORS_ORIGINS` | REQUIRED_PRODUCTION (decisão) | vazio | origens exatas do Admin Web; vazio = nenhum browser de outra origem |
| `REALTIME_ALLOWED_ORIGINS` | REQUIRED_PRODUCTION (decisão) | = `CORS_ORIGINS` | em produção, sem lista, todo Origin de browser é recusado |
| `SWAGGER_ENABLED` | OPTIONAL_SAFE_DEFAULT | off em produção | |
| `SECURITY_HSTS_MAX_AGE_SECONDS` | OPTIONAL (decisão) | `0` | HSTS na app ou no proxy TLS |
| `AUTH_REFRESH_REUSE_GRACE_MS` | OPTIONAL_SAFE_DEFAULT | `10000` | 0 = estrito |
| `STAFF_LOGIN_RATE_LIMIT_WINDOW` / `_PER_IP` / `_PER_USERNAME` | OPTIONAL_SAFE_DEFAULT | `15m` / `30` / `10` | por processo; calibrar na 12.6 |
| `STAFF_LOGIN_MAX_CONCURRENT` | OPTIONAL_SAFE_DEFAULT | `4` | Argon2 de 64 MiB simultâneos |
| `STAFF_REFRESH_RATE_LIMIT_WINDOW` / `_PER_IP` / `_PER_SESSION` | OPTIONAL_SAFE_DEFAULT | `1m` / `60` / `10` | |
| `PLAYER_AUTH_RATE_LIMIT_PER_MINUTE` | OPTIONAL_SAFE_DEFAULT | `20` | por rota e IP |
| `PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE` | OPTIONAL_SAFE_DEFAULT | `30` | por Player |
| `PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE` | OPTIONAL_SAFE_DEFAULT | `30` | por Player |
| `REALTIME_MAX_CONNECTIONS` / `_MAX_PENDING_CONNECTIONS` / `_MAX_CONNECTIONS_PER_IDENTITY` | OPTIONAL_SAFE_DEFAULT | `10000` / `500` / `5` | |
| `REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE` | OPTIONAL_SAFE_DEFAULT | `60` | por IP |
| `REALTIME_AUTH_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `5000` | |
| `AGENT_MAX_PENDING_CONNECTIONS` / `AGENT_MAX_CONCURRENT_AUTH` | OPTIONAL_SAFE_DEFAULT | `32` / `8` | |
| `AGENT_CONNECT_RATE_LIMIT_PER_MINUTE` / `AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE` | OPTIONAL_SAFE_DEFAULT | `30` / `10` | por IP |

## Player, Agent e workers

| Variável | Classe | Default | Notas |
| --- | --- | --- | --- |
| `PLAYER_LINK_CHALLENGE_TTL` | OPTIONAL_SAFE_DEFAULT | `10m` | 1m–1h |
| `PLAYER_GROUP_INVITE_TTL` / `PLAYER_GUILD_INVITE_TTL` | OPTIONAL_SAFE_DEFAULT | `10m` / `7d` | |
| `PLAYER_CHAT_RETENTION` | OPTIONAL_SAFE_DEFAULT | `7d` | 1d–30d |
| `PLAYER_CHAT_RATE_LIMIT_COUNT` / `_WINDOW` | OPTIONAL_SAFE_DEFAULT | `5` / `10s` | |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URIS` | REQUIRED_PRODUCTION se houver login Player | vazio | tudo ou nada; sem eles o exchange responde 503 |
| `GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `30000` | ≥ `AGENT_HEARTBEAT_TIMEOUT` |
| `AGENT_AUTH_TIMEOUT_MS` | OPTIONAL_SAFE_DEFAULT | `5000` | |
| `AGENT_HEARTBEAT_INTERVAL` / `AGENT_HEARTBEAT_TIMEOUT` | OPTIONAL_SAFE_DEFAULT | `10s` / `30s` | o idle timeout do proxy precisa ser maior que o intervalo |
| `AGENT_MAX_IN_FLIGHT_COMMANDS` | OPTIONAL_SAFE_DEFAULT | `32` | |
| `AGENT_MESSAGE_RATE_LIMIT_COUNT` / `_WINDOW_MS` | OPTIONAL_SAFE_DEFAULT | `200` / `10000` | |
| `AGENT_WORK_PUSH_INTERVAL_MS` | OPTIONAL_SAFE_DEFAULT | `2000` | |
| `GAME_COMMAND_ACK_TIMEOUT_MS` / `_EXECUTION_TIMEOUT_MS` / `_MAX_DISPATCH_ATTEMPTS` / `_PENDING_TIMEOUT_MS` / `_WORKER_INTERVAL_MS` | OPTIONAL_SAFE_DEFAULT | `5000` / `30000` / `3` / `60000` / `500` | |
| `SERVER_CONTROL_PENDING_TIMEOUT_MS` / `_DELIVERY_WINDOW_MS` / `_RESULT_TIMEOUT_MS` / `_WORKER_INTERVAL_MS` | OPTIONAL_SAFE_DEFAULT | `30000` / `10000` / `300000` / `1000` | result > window |
| `VIP_DELIVERY_WORKER_INTERVAL_MS` | OPTIONAL_SAFE_DEFAULT | `2000` | |
| `OPERATIONS_STALE_AFTER_MS` | OPTIONAL_SAFE_DEFAULT | `900000` | 12.4: idade (60 000–604 800 000 ms) a partir da qual um item de fila de operador é marcado `stale`. Só classificação: nada falha nem é reenviado por idade (`docs/operational-recovery.md`) |
| `OPERATIONS_ACTION_RATE_LIMIT_PER_MINUTE` | OPTIONAL_SAFE_DEFAULT | `30` | 12.4: ações de operador (POST `/operations/…`) por usuário Staff por minuto (1–1000); 429 com `Retry-After` |

## Observabilidade (12.3, `docs/observability.md`)

| Variável | Classe | Default | Notas |
| --- | --- | --- | --- |
| `METRICS_ENABLED` | OPTIONAL_SAFE_DEFAULT | `false` em produção, `true` fora | desligado, `/api/v1/metrics` é 404 |
| `METRICS_BEARER_TOKEN` | REQUIRED_PRODUCTION se métricas ligadas | — | ≥ 32 caracteres sem espaço; o boot falha sem ele em produção com métricas ligadas; nunca é logado |
| `METRICS_COLLECTION_INTERVAL_MS` | OPTIONAL_SAFE_DEFAULT | `15000` | 1000–300000; intervalo das queries agregadas de backlog |
| `LOG_FORMAT` | OPTIONAL_SAFE_DEFAULT | `json` em produção, `pretty` fora | `json` ou `pretty` |
| `LOG_LEVEL` | OPTIONAL_SAFE_DEFAULT | `log` | error, warn, log, debug, verbose |
| `APP_VERSION` | OPTIONAL | `unknown` | `[\w.+-]{1,64}`; label de `skyrim_admin_app_info` |
| `GIT_SHA` | OPTIONAL | `unknown` | 7–40 hex; label de `skyrim_admin_app_info` |

## Operação pontual e testes

| Variável | Classe | Notas |
| --- | --- | --- |
| `BOOTSTRAP_COORDINATOR_USERNAME`, `_DISPLAY_NAME`, `_PASSWORD` | DEV_ONLY / operação | só para `node dist/staff/bootstrap.js`; remova do ambiente após o uso |
| `TEST_DATABASE_INTEGRATION` | TEST_ONLY | liga as suítes com PostgreSQL real |
| `POSTGRES_*` (docker-compose) | DEV_ONLY | o compose sobe só o PostgreSQL local |

## Checagem

`npm run preflight` (ou `node dist/database/preflight.js` na imagem):
- **ERROR**: `NODE_ENV` diferente de `production`; lock desligado; banco inacessível; PostgreSQL < 13; `uuid-ossp` indisponível no servidor, ou ausente com `--require-current`; migration pendente com `--require-current`.
- `uuid-ossp` ausente mas disponível, sem `--require-current`, é **WARN**: quem cria a extensão é o migration runner. O preflight e o `/ready` nunca criam nada, e a aplicação não precisa de privilégio de `CREATE EXTENSION` (`docs/deployment.md`, "Fronteira de schema").
- **WARN**: as decisões pendentes, como `TRUST_PROXY=false`, CORS e origins vazios, HSTS 0, Swagger ligado, TLS do banco desligado para host remoto ou `require` sem verificação.

Exit 1 em qualquer ERROR.
