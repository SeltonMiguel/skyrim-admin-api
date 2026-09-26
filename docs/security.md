# Security boundary and abuse controls (12.1)

Controles de segurança e abuso da réplica única, implementados na Etapa 12.1.
Todos os limites são **por processo**: com mais de uma réplica, cada instância
conta sozinha, e o limite efetivo vira N × limite. A troca por um store
compartilhado é da 12.5; os defaults são uma baseline conservadora que a 12.6
calibra com medições de carga.

## Rate limiting: uma abstração

`RateLimiter` (`src/common/rate-limit/rate-limiter.ts`) é o único primitivo:

- janela fixa por `(scope, key)`;
- `consume` conta a tentativa e decide; `check` só consulta; `reset` esquece uma chave ou um scope; toda recusa traz `retryAfterSeconds`;
- a implementação em memória (`MemoryRateLimiter`) limita o mapa a 50 000 chaves: poda as janelas vencidas e, se ainda estiver cheio, descarta as chaves mais antigas;
- é registrado no `CommonModule` (global); a 12.5 troca só o provider.

`ConcurrencyLimiter` limita operações caras simultâneas (Argon2, verificação de
HELLO): um slot ocupado recusa na hora, sem fila.

O limiter do chat (`src/player-chat/chat-rate-limiter.ts`) foi mantido à parte
de propósito: é uma janela deslizante em que cada slot pertence a uma
Idempotency-Key, uma semântica diferente de "tentativas por janela".

Toda recusa HTTP é o mesmo 429 genérico (`Too many requests`) com
`Retry-After`, definido pelo filtro global. A resposta nunca diz qual bucket
estourou.

| Scope | Chave | Default (env) | Onde |
| --- | --- | --- | --- |
| `staff-login-ip` | IP do cliente | 30 / 15 min (`STAFF_LOGIN_RATE_LIMIT_PER_IP`, `STAFF_LOGIN_RATE_LIMIT_WINDOW`) | `src/auth/staff-auth-throttle.ts` |
| `staff-login-username` | username normalizado | 10 / 15 min (`STAFF_LOGIN_RATE_LIMIT_PER_USERNAME`) | idem |
| Argon2 simultâneos | — | 4 (`STAFF_LOGIN_MAX_CONCURRENT`) | idem |
| `staff-refresh-ip` | IP | 60 / min (`STAFF_REFRESH_RATE_LIMIT_PER_IP`) | idem |
| `staff-refresh-session` | sessionId (após verificar o JWT) | 10 / min (`STAFF_REFRESH_RATE_LIMIT_PER_SESSION`) | idem |
| `player-auth` | rota + IP | 20 / min (`PLAYER_AUTH_RATE_LIMIT_PER_MINUTE`) | `src/player-auth/player-auth-rate-limit.ts` (exchange, refresh, POST character-links) |
| `player-characterQueries` | playerId | 30 / min (`PLAYER_CHARACTER_QUERY_RATE_LIMIT_PER_MINUTE`) | `src/player-auth/player-action-rate-limit.ts`: as 5 queries de personagem (criam GameCommands) |
| `player-marketMutations` | playerId | 30 / min (`PLAYER_MARKET_MUTATION_RATE_LIMIT_PER_MINUTE`) | criar trade, criar listing, comprar, cancelar listing |
| `realtime-connect` | IP | 60 / min (`REALTIME_CONNECT_RATE_LIMIT_PER_MINUTE`) | `src/realtime/realtime.gateway.ts` |
| `agent-connect` | IP | 30 / min (`AGENT_CONNECT_RATE_LIMIT_PER_MINUTE`) | `src/game-agent/agent.gateway.ts` |
| `agent-auth-failure` | IP | 10 falhas / min (`AGENT_AUTH_FAILURE_LIMIT_PER_MINUTE`) | idem |
| frames do Agent | socket | 200 / 10 s (existente) | idem |

## Login Staff

Ordem em `AuthService.login`:
1. bucket por IP;
2. bucket por username;
3. slot de Argon2;
4. só então o banco e o Argon2.

Os dois buckets evitam os dois extremos. Só por IP, um NAT inteiro seria
punido e um ataque distribuído contra uma conta não teria limite. Só por
username, qualquer um poderia travar a conta de outra pessoa sem limite por
origem. Com os dois, uma conta sob ataque fica protegida mesmo quando as
tentativas vêm de outros IPs, e um IP abusivo é contido para todas as contas.

Custo conhecido: quem sabe um username pode travar aquela conta por uma janela
(10 tentativas em 15 min). O login bem-sucedido limpa o bucket do username.

Usuário inexistente verifica contra um hash dummy cacheado. Não gera Argon2
novo por request, e o custo é comparável ao de uma senha errada.

## Refresh token: rotação e detecção de reuso

Staff e Player têm o mesmo modelo, **sem migration**:
- a sessão guarda só o sha256 do refresh atual (`refresh_token_hash`) e `last_used_at` (instante da última rotação);
- um refresh com assinatura válida, para a sessão certa, cujo hash difere do atual foi emitido por nós e já foi rotacionado.

| Situação | Resposta | Efeito |
| --- | --- | --- |
| Token atual | 200 | nova rotação (hash substituído, `last_used_at` = agora) |
| Token rotacionado até `AUTH_REFRESH_REUSE_GRACE_MS` (default 10 s) após a última rotação | 401 genérico | nada: o perdedor de dois refresh simultâneos, a sessão continua |
| Token rotacionado depois da janela | 401 genérico | **reuso**: só aquela sessão é revogada; Audit `AUTH_REFRESH_REUSE_DETECTED` (Staff, actor STAFF) ou `PLAYER_AUTH_REFRESH_REUSE_DETECTED` (Player, actor PLAYER), resource `STAFF_SESSION`/`PLAYER_SESSION`; log de segurança (só Staff) |
| Sessão revogada ou expirada | 401 genérico | nada (sem Audit repetido) |

As outras sessões da conta não são derrubadas: o reuso compromete uma família,
não a conta.

Duas chamadas simultâneas com o mesmo token serializam no `FOR UPDATE` da
sessão. Uma rotaciona e a outra vê o hash novo dentro da janela. Resultado: no
máximo uma rotação, e a sessão nunca fica com dois refresh válidos.

Limitação aceita: dentro da janela de graça, qualquer token antigo da mesma
sessão é tratado como corrida, não como reuso. Distinguir "o imediatamente
anterior" de "mais antigo" exigiria guardar o hash anterior (migration). Com
`AUTH_REFRESH_REUSE_GRACE_MS=0` a política fica estrita: qualquer token
rotacionado revoga, inclusive o perdedor de uma corrida legítima.

Clientes (Admin Web, Electron) devem fazer refresh em single-flight.

### Sessão Player e realtime

Cada socket Player autenticado fica registrado com o `sessionId` da sessão que
o autenticou (só o id; nunca o access, o refresh ou o JWT).

Quando o backend revoga uma sessão Player, publica `RealtimeSessionControl`
**depois do commit**. Hoje há duas revogações: logout e reuso de refresh
confirmado. O gateway então:
- remove do registry todos os sockets daquela sessão;
- fecha cada um com **4001 `SESSION_REVOKED`** (mesmo código de UNAUTHORIZED, motivo distinto);
- registra `realtime_session_revoked`.

Garantias:
- como o socket sai do registry antes do close, nenhum evento publicado depois chega a ele;
- as outras sessões da mesma conta continuam conectadas e recebendo;
- um AUTH verificado pouco antes da revogação e concluído depois é recusado com o mesmo 4001 (o gateway lembra as revogações recentes por até 1 h, com limite de 10 000);
- revogar de novo, ou revogar sessão já fechada, é inofensivo.

A grace window, o Audit e a detecção de reuso não mudaram.

Staff: sem mudança. Os grants são revalidados a cada entrega, e uma conta
desativada fecha com 4001 na próxima entrega.

**Status de conta (12.4):** `POST /api/v1/operations/players/:playerId/status`
(`PLAYER_ACCOUNT_MODERATE`, Idempotency-Key, reason, Audit
`PLAYER_ACCOUNT_STATUS_CHANGED`) muda a conta para ACTIVE, SUSPENDED ou BANNED.
Ao sair de ACTIVE, revoga na mesma transação todas as sessões ativas da conta
e, depois do commit, `RealtimeSessionControl.playerAccountRevoked` faz o
gateway lembrar essas sessões como revogadas (AUTH em voo recusado) e fechar
**todos** os sockets da conta com **4001 `ACCOUNT_DISABLED`**
(`realtime_account_disabled`). Voltar a ACTIVE não revive sessão: o Player faz
login de novo. Mudança de status por SQL continua sem fechar sockets: use a
API (`docs/operational-recovery.md` §5.11).

Instância única: o fechamento é in-process. Com várias réplicas, um socket em
outra instância só fecha com o close distribuído da 12.5.

## Proxy e IP do cliente

A política é `TRUST_PROXY`, validada no boot:
- `false` (default): `X-Forwarded-For` é ignorado;
- `<n>`: confia nos n hops mais próximos;
- lista de `loopback`, `linklocal`, `uniquelocal`, IPs e CIDRs;
- `true` é recusado, porque deixaria qualquer cliente escolher o próprio IP.

A mesma função (`src/common/net/client-ip.ts`) serve:
- ao Express (`trust proxy`, portanto `request.ip`);
- ao rate limit HTTP;
- ao Audit e às sessões (`ip_address`);
- aos upgrades WebSocket (`ClientAddress.of`).

A resolução percorre a cadeia a partir do peer e para no primeiro endereço que
não é proxy confiável. O prefixo escolhido pelo cliente nunca é usado.

Atrás de um reverse proxy em produção, configure a lista ou o número exato de
proxies; sem isso, todos os Players compartilham o bucket do proxy.

## CORS e Origin

- `CORS_ORIGINS`:
  - origens exatas (`scheme://host[:port]`); wildcard e path são recusados;
  - vazio: nenhum header CORS (o comportamento anterior);
  - métodos GET/POST/PUT/PATCH/DELETE;
  - headers `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Request-Id`;
  - expõe `X-Request-Id`, `Retry-After` e `Location`;
  - `credentials: false` (Bearer, sem cookies).
- Realtime (`/api/v1/realtime`):
  - `REALTIME_ALLOWED_ORIGINS` (default `CORS_ORIGINS`);
  - request **com** Origin fora da lista: 403 antes do upgrade;
  - sem lista: qualquer Origin é aceito só fora de produção;
  - request **sem** Origin (Electron main process, cliente nativo) é julgado só pelo token;
  - um renderer Electron que usa o WebSocket do browser envia Origin (`file://`, `app://…`); inclua-o na lista.
- Agent (`/api/v1/agent`): Origin é ignorado. O Host Agent é headless e a credencial continua sendo a autoridade.

## Headers HTTP (Helmet)

- **API:**
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`;
  - `Cross-Origin-Resource-Policy: same-site`;
  - demais defaults do Helmet;
  - sem `X-Powered-By`.
- **`/docs`** (quando habilitado): os defaults do Helmet, para a Swagger UI funcionar.
- **HSTS** é opt-in (`SECURITY_HSTS_MAX_AGE_SECONDS`), porque o TLS termina no proxy.

## Swagger

`SWAGGER_ENABLED` tem default ligado fora de produção e desligado com
`NODE_ENV=production`. Desligado, `/docs` e `/docs-json` dão 404. Se um operador
ligar em produção, o documento mapeia todas as rotas: deixe atrás de rede
privada ou de autenticação no proxy.

## RBAC fail-closed

- `PermissionGuard` **nega** (403) um handler sem `@RequirePermissions(...)`.
- Rotas cuja permissão depende do recurso gravado declaram `@PermissionsCheckedInService()`. São 5: os GETs de `character-operations`, `moderation-operations`, `world-operations` e `server-control-operations`, e a lista de Server Control.
- `PermissionMetadataValidator` impede o **startup** se alguma rota com `PermissionGuard` não tiver nenhuma das duas metadatas.
- `src/rbac/permission-metadata.spec.ts` faz a mesma checagem varrendo todos os controllers.
- Rotas públicas e Player não usam `PermissionGuard` e não são afetadas.

## WebSocket: tetos

| Superfície | Controle | Comportamento |
| --- | --- | --- |
| Realtime | Origin | 403 no upgrade |
| Realtime | tentativas por IP (cobre flood de AUTH: uma tentativa por socket) | 429 com Retry-After no upgrade |
| Realtime | sockets não autenticados (`REALTIME_MAX_PENDING_CONNECTIONS` 500) e total (`REALTIME_MAX_CONNECTIONS` 10000) | 503 no upgrade |
| Realtime | sockets por identidade (`REALTIME_MAX_CONNECTIONS_PER_IDENTITY` 5) | o **novo** socket fecha com 4004 `CONNECTION_LIMIT` depois do AUTH; os existentes ficam |
| Agent | tentativas por IP | 429 no upgrade |
| Agent | falhas de HELLO por IP (credencial inválida) | depois do limite, 429 no upgrade até a janela passar |
| Agent | sockets aguardando HELLO (`AGENT_MAX_PENDING_CONNECTIONS` 32) | 503 no upgrade |
| Agent | verificações de HELLO simultâneas (`AGENT_MAX_CONCURRENT_AUTH` 8) | close 4013 `AUTH_BUSY`; o Agent refaz com backoff |

Um Agent válido nunca fica bloqueado indefinidamente: todo bloqueio é por
janela e por IP. O HELLO continua verificando a credencial real com
`timingSafeEqual`.

## Log de segurança e Audit

`SecurityLog` (`src/common/security/security-log.ts`) emite eventos
`chave=valor` sanitizados contra log injection:
- `staff_login_throttled`, `staff_login_busy`;
- `staff_refresh_throttled`, `staff_refresh_stale`, `staff_refresh_reuse_revoked`;
- `realtime_origin_refused`, `realtime_connect_throttled`, `realtime_capacity_refused`, `realtime_identity_limit`;
- `agent_hello_blocked`, `agent_capacity_refused`, `agent_hello_busy`;
- `staff_route_without_permission`.

Usernames entram só como fingerprint sha256 truncado. Nunca aparecem senha,
JWT, refresh, segredo do Agent nem challenge.

Por regra de fronteira (`src/player-auth/player-auth.spec.ts`), o módulo
`player-auth` não loga. O reuso de refresh Player vai só para o Audit.

Recusas por rate limit não viram Audit: o volume permitiria amplificação.
Só o reuso de refresh (revogação de sessão) é auditado.

## Limites HTTP

- body JSON de 100 kB (default do Express), coberto por teste;
- um body maior responde 413. Antes da 12.1 respondia 500, porque o filtro global não reconhecia o erro do body parser; agora qualquer 4xx exposto pelo parser (413, JSON malformado) mantém seu status, com mensagem genérica;
- DTOs com `whitelist`, `forbidNonWhitelisted` e `transform`; `limit ≤ 100` em todas as listas.

## Testes

- `test/security.e2e-spec.ts`: login (username, IP, Argon2 limitado, conta desconhecida, janela), IP por proxy confiável, refresh (rotação, corrida, reuso, sessão revogada, hash apenas), throttle de refresh, reuso Player, headers/CORS/Swagger, body, Origin/tetos/flood no realtime, HELLO no Agent, limites por Player, RBAC em rotas públicas/Player/delegadas;
- `test/auth.e2e-spec.ts`: X-Forwarded-For forjado sem proxy confiável;
- unitários: `src/common/net/client-ip.spec.ts`, `src/common/rate-limit/rate-limiter.spec.ts`, `src/rbac/permission-metadata.spec.ts`, `src/config/environment.spec.ts` (defaults e parsing), `src/game-agent/game-agent.spec.ts` (`AUTH_BUSY`).

## Dependência: multer

`npm audit` segue com 2 HIGH em `multer` 2.2.0, trazido por
`@nestjs/platform-express` 12.0.1. O backend não registra nenhum
`FileInterceptor` nem multipart (grep vazio), então os advisories não são
alcançáveis. Não foi aplicado `npm audit fix`. Proposta: subir `@nestjs/*` para
12.1.x (platform-express 12.1.0 usa multer 2.4.0), num commit isolado com a
suíte completa.

## Produção (12.2)

`node dist/database/preflight.js` lista como WARN as decisões de segurança que
o ambiente real precisa tomar explicitamente:
- `TRUST_PROXY=false` atrás de proxy;
- `CORS_ORIGINS` e `REALTIME_ALLOWED_ORIGINS` vazios;
- HSTS 0;
- Swagger ligado;
- TLS do banco desligado para host remoto, ou `require` sem verificação.

Não força CORS: um deploy sem browser em outra origem pode deixar vazio,
desde que como decisão consciente. Produção exige `DB_SSL_MODE` explícito e o
lock de instância única. O servidor recusa `NODE_ENV=test`, que aceita
segredos efêmeros.

## Métricas e logs (12.3)

- `/api/v1/metrics` fica desligado em produção por padrão. Ligado, exige `METRICS_BEARER_TOKEN`, comparado em tempo constante; não usa Staff JWT.
- Os labels nunca carregam id, IP nem username.
- Logs em JSON passam por redaction central (chave e valor): JWT, bearer, PEM, senha em URL, chaves de segredo.

Detalhes em `docs/observability.md`.
