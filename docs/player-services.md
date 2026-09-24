# Etapa 10 — Player Services: decisões de arquitetura (10.0)

Documento de decisões. Não há código, migration ou endpoint nesta subetapa. Ele
fixa identidade, autenticação, ownership, ator, idempotência e as regras de base
de cada domínio que as subetapas 10.1–10.17 implementarão, além das fronteiras com
Admin API, Game Bridge, Electron, Launcher e Agent.

Todos os domínios listados no roadmap fazem parte da Etapa 10 e devem estar
implementados antes da Etapa 11. As decisões marcadas como provisórias valem até
revisão explícita deste documento.

## Estado de partida

- O backend conhece somente staff: `staff_users`, `staff_sessions`, JWT HS256 com
  issuer `skyrim-admin-api` e audience `skyrim-admin-access`/`skyrim-admin-refresh`,
  RBAC por role.
- Não existe Player, Account, autenticação de jogador nem vínculo
  player ↔ character. `playerId` (Moderation) e `characterId` (Character) são
  strings opacas, escopadas pelo servidor da rota e sem relação entre si.
- Estado runtime (personagens, inventário, propriedades, holds, cavalos, facções)
  vive apenas no Skyrim; o backend não mantém snapshots (Etapa 05).
- A única superfície player-facing é o catálogo VIP público e anônimo
  (`/api/v1/vip-store/offers`, Etapa 08).
- Autoria e Audit supõem staff: `game_commands.requested_by_staff_id` → `staff_users`,
  `audit_logs.actor_*` com `actor_role` do tipo `RoleName`.
- Idempotência de GameCommand é `UNIQUE(game_server_id, idempotency_key)`,
  compartilhada entre atores: um replay equivalente devolve o command criado por
  outro staff. Isso é aceitável entre staff e inaceitável entre players.
- Não existe transporte real (gateways Disconnected) nem realtime.

## Arquitetura

```text
Admin Web ──► Admin API  (/api/v1/...)          Staff JWT + RBAC
                  │
                  ├──► serviços de domínio ◄──┐  política injetada:
                  │                           │  permission (staff) | ownership (player)
Electron ───► Player API (/api/v1/player/...) ┘  Player JWT, sem RBAC
   │              │
   │              ├──► Ledger / Escrow (fonte de verdade econômica)
   │              ▼
   │         Game Bridge (GameCommand, ator genérico) ──► gateway ──► SKSE/Agent
   │
   └──► Realtime WebSocket (Player e Admin; eventos de groups, chat, trade, status)

Launcher C# ── local: arquivos, mods, integridade, atualização, abertura do jogo
```

| Camada | Responsabilidade | Não faz |
| --- | --- | --- |
| Admin API | Operações de staff, RBAC, Audit administrativo | Aceitar token de player |
| Player API | Operações do próprio jogador, autorização por ownership, DTOs player-safe | Aceitar token de staff; expor dados de outros jogadores, `requestedByStaffId`, Idempotency-Key, lease ou payloads internos |
| Serviços de domínio | Regras e contratos compartilhados (ex.: validadores de Character, ledger) | Depender de qual API os chamou além da política recebida |
| Game Bridge | Fila, dispatch, lease, resultados; interno e agnóstico de ator | Autenticar HTTP, decidir autorização ou ser fonte de saldo |
| Realtime (WebSocket) | Transportar às UIs os eventos internos publicados pelos domínios, autenticado por audience | Ser fonte de verdade; conter regra de domínio; aceitar mutation sem passar pelos serviços de domínio |
| Electron | Consumidor da Player API e do realtime | — (nenhuma dependência Electron no backend) |
| Launcher C# | Mods, arquivos, integridade, atualização e abertura do jogo | Chamar Admin API |
| SKSE/Agent | Fonte de verdade do runtime Skyrim; confirma ownership; emite eventos confiáveis; reflete efeitos no jogo | Receber comando textual arbitrário |

Player API e Admin API são superfícies distintas sobre os mesmos serviços de
domínio. A Player API nunca chama controllers administrativos. O prefixo
`/api/v1/player/...` evita colisão com `GET /api/v1/auth/me` (staff).

## Roadmap da Etapa 10

| Subetapa | Conteúdo |
| --- | --- |
| 10.0 Player Architecture Decisions | Este documento |
| 10.1 Player Account Model | **Implementada.** `players`, `player_identities`, status, migration `1789890000000-PlayerAccounts` |
| 10.2 Generic Actor + Player-safe Idempotency | **Implementada.** Ator STAFF/PLAYER/SYSTEM em Audit e GameCommand; idempotency scope; `ActorCommandService`; migration `1789900000000-GenericActor` |
| 10.3 Player Authentication | **Implementada.** Discord OAuth2, auto-provisioning, `player_sessions`, tokens, `PlayerAuthGuard`, `GET /api/v1/player/me`; migration `1789910000000-PlayerSessions` |
| 10.4 Character Ownership | **Implementada.** `player_characters`, challenges de vínculo, Player API mínima, `CharacterOwnershipService`, `confirmFromAgent` interno; migration `1789920000000-PlayerCharacters` |
| 10.5 Character Profile + Skills | **Implementada.** `CHARACTER_PROFILE_QUERY`, `CHARACTER_SKILLS_QUERY`, Player API 202 + operation detail; sem migration |
| 10.6 Multiple Characters | **Implementada.** `GET /api/v1/player/me/characters` e detalhe; sem migration |
| 10.7 Professions | Profissão ativa por character, XP e nível persistidos |
| 10.8 Groups + Realtime Foundation | Infraestrutura WebSocket e barramento de eventos internos; party com leader, members e invites como primeiro domínio realtime |
| 10.9 Guilds / Clans | Guildas persistentes com membros, cargos e convites |
| 10.10 Properties / Houses / Holds | Leitura reutilizando contratos Character, por ownership |
| 10.11 Horses / Mounts | Leitura reutilizando contratos Character, por ownership |
| 10.12 Economy / Wallet | Ledger imutável e wallet derivada |
| 10.13 Player Trade | Trade entre players com escrow; LEDGER_CURRENCY e GAME_ITEM |
| 10.14 Marketplace | Listings sobre wallet/ledger/escrow, com as mesmas regras de custódia do Trade |
| 10.15 Chat | Chat event-driven sobre a infraestrutura realtime da 10.8 |
| 10.16 Player Settings | Preferências de conta com allowlist explícita |
| 10.17 VIP Player Integration | Integração do catálogo existente na superfície do player |

Dependências de fundação: 10.1 → 10.2 → 10.3 → 10.4. Domínios que atuam sobre
characters (10.5, 10.6, 10.7, 10.10, 10.11) exigem ownership VERIFIED. Trade e
Marketplace (10.13, 10.14) exigem Economy (10.12). A 10.8 cria a infraestrutura
realtime; Chat (10.15) e os eventos de Guilds, Trade e Marketplace a reutilizam.

## Decisões provisórias

### Auth

- Arquitetura **provider-based**: o resultado de qualquer login é
  `(provider, providerSubject)`, resolvido para `players.id`.
- **Discord OAuth2** é o provider inicial.
- Outros providers podem ser vinculados depois ao mesmo player, via
  `player_identities`, sem mudar `players.id`.
- **Player JWT, sessions, secrets e audience separados de Staff.** Nenhum token de
  staff é aceito pela Player API e nenhum token de player é aceito pela Admin API.
  Não há reutilização de `JwtAuthGuard`, `PermissionGuard`, RBAC, `staff_sessions`
  ou `JWT_*_SECRET`.
- Autorização na Player API é por ownership e status da conta, não por roles.
- **Login e posse de character são problemas separados.** Autenticar prova quem é
  o player; não prova que um character pertence a ele.

#### Implementação (10.3)

Módulo `src/player-auth/`, independente de `AuthModule`: não importa staff, RBAC,
`JwtAuthGuard`, `TokenService` ou `staff_sessions`.

**Fluxo Discord**

```text
Electron ── abre authorize (identify, state, PKCE opcional) ──► Discord
Electron ◄── callback com code; valida state (Etapa 11)
Electron ── POST /api/v1/player/auth/discord/exchange { authorizationCode, redirectUri, codeVerifier? }
Backend  ── POST oauth2/token com client_secret server-side ──► Discord
Backend  ── GET users/@me com o access token (descartado) ──► Discord
Backend  ── provisiona/encontra player, cria player_sessions, emite tokens
```

- `PlayerIdentityProvider` é a abstração; `DiscordIdentityProvider` a primeira
  implementação. O adapter devolve somente `provider`, `providerSubject` (id do
  usuário Discord) e `displayName` (`global_name` ou `username`, saneado e limitado
  a 64). Resposta bruta, e-mail, avatar e tokens do Discord nunca saem do adapter
  nem são persistidos.
- `redirectUri` precisa coincidir exatamente com uma entrada de
  `DISCORD_REDIRECT_URIS`; caso contrário, 401 antes de contatar o Discord.
- `codeVerifier` (RFC 7636, 43–128 caracteres) é repassado ao token endpoint como
  `code_verifier` quando enviado. O suporte do Discord deve ser confirmado na
  integração do Electron (Etapa 11).
- Grant rejeitado (4xx) → 401; falha de rede/5xx/resposta inválida → 503; Discord
  não configurado → 503. Mensagens de erro são fixas, sem corpo do provider.
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` e `DISCORD_REDIRECT_URIS` são
  opcionais em conjunto; configuração parcial ou URI inválida falha na
  inicialização. O client secret nunca é enviado ao Electron.
- **Fronteira Electron/OAuth:** gerar e validar `state`, abrir o navegador,
  receber o callback e gerar o PKCE são responsabilidade do Electron (Etapa 11).
  O backend só redime o code.

**Auto-provisioning:** o primeiro login válido procura a identidade
`(DISCORD, subject)`; se não existir, `createPlayer` cria player ACTIVE e identity
na mesma transação (10.1). Logins concorrentes da mesma identidade convergem: o
perdedor recebe 409 da UNIQUE e relê o vencedor. Não exige e-mail.

**Sessões e tokens**

| Item | Valor |
| --- | --- |
| Tabela | `player_sessions` (`id`, `player_id` FK, `refresh_token_hash`, `expires_at`, `revoked_at`, `last_used_at`, `created_at`) |
| Hash | SHA-256 hex do refresh token atual (check `^[0-9a-f]{64}$`); sem IP, user agent ou token de provider |
| Access JWT | HS256, `PLAYER_JWT_ACCESS_SECRET`, issuer `skyrim-player-api`, audience `skyrim-player-access`, `PLAYER_JWT_ACCESS_TTL` (padrão 15m, máx. 1h) |
| Refresh JWT | `PLAYER_JWT_REFRESH_SECRET`, audience `skyrim-player-refresh`, `PLAYER_JWT_REFRESH_TTL` (padrão 30d, máx. 90d) |
| Expiração | Absoluta, definida no login; refresh nunca a estende |

As secrets de player são obrigatórias fora de `test`, têm no mínimo 32 caracteres
e não podem ser iguais entre si nem às secrets de staff; não há fallback. Refresh
rotaciona: o hash é substituído sob lock, então o token anterior (inclusive um
replay concorrente) recebe 401, como no Staff Auth. Logout revoga a sessão atual.

**Status:** o `PlayerAuthGuard` aceita apenas access JWT de player, valida
issuer/audience/assinatura e relê sessão e player a cada request. ACTIVE é
obrigatório em login, refresh e em toda request autenticada; SUSPENDED e BANNED
recebem 403 (`Player account unavailable`), inclusive com access token ainda não
expirado. Sessão revogada, expirada ou token inválido → 401. O guard expõe
`{ player, sessionId, actor: PlayerActor }` em slot próprio da request, sem roles
ou permissions.

**Rotas**

| Rota | Auth | Resposta |
| --- | --- | --- |
| `POST /api/v1/player/auth/discord/exchange` | pública, rate limited | 200 tokens + `player` |
| `POST /api/v1/player/auth/refresh` | refresh token no body, rate limited | 200 tokens + `player` |
| `POST /api/v1/player/auth/logout` | access player | 204 |
| `GET /api/v1/player/me` | access player | `{ id, displayName, status, identities: [{ provider, linkedAt }] }` |

`/player/me` deriva sempre do token; qualquer query (por exemplo `playerId`)
retorna 400. Nenhuma resposta inclui `providerSubject`, dados de sessão ou hashes.
Respostas de auth usam `Cache-Control: no-store`.

**Rate limiting:** janela fixa de 60 s por rota e IP (`request.ip`), com
`PLAYER_AUTH_RATE_LIMIT_PER_MINUTE` (padrão 20); excedente → 429 com
`Retry-After`. É em memória e por processo, sem Redis. Limite distribuído entre
instâncias, confiança em proxies e cotas por conta serão endurecidos na Etapa 12.

**Audit:** login, refresh e logout de player não são auditados. O Audit é a trilha
administrativa append-only; os eventos de sessão têm volume alto e a própria
`player_sessions` registra criação, uso e revogação. Assim nenhum dado de provider
chega ao Audit. Mutations futuras do player serão auditadas com ator PLAYER (10.2).

**Fora desta subetapa:** Character Ownership, implementado na 10.4.

### Account

- **`players.id` (UUID) é a identidade canônica interna.**
- Identidades externas em `player_identities` (`player_id`, `provider`,
  `provider_subject`), com `UNIQUE(provider, provider_subject)`.
- Status: **ACTIVE / SUSPENDED / BANNED**.
- **Dados pessoais mínimos**: somente o necessário para identificar e exibir o
  player. Dados do provider não entram em Audit.
- **Sem relação estrutural com `staff_users`**: nenhuma FK, coluna compartilhada ou
  herança. Uma pessoa que é staff e joga possui duas identidades independentes.
- O `playerId` opaco da Moderation permanece identificador externo do jogo; sua
  associação a `players.id` não é inferida.

#### Implementação (10.1)

Módulo `src/player-accounts/`, sem controllers, guards, tokens ou sessões. Nenhuma
rota HTTP nova.

`players`:

| Coluna | Tipo | Regras |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `status` | varchar(16) | default `ACTIVE`; `players_status_check` IN (ACTIVE, SUSPENDED, BANNED) |
| `display_name` | varchar(64) | trim, 1–64 unidades UTF-16, Unicode válido, sem C0/C1; não único; `players_display_name_check` exige não vazio após trim |
| `created_at`, `updated_at` | timestamptz | default `now()` |

`player_identities`:

| Coluna | Tipo | Regras |
| --- | --- | --- |
| `id` | uuid PK | `gen_random_uuid()` |
| `player_id` | uuid | `player_identities_player_fkey` → `players(id)`, sem cascade; índice `player_identities_player_idx` |
| `provider` | varchar(32) | `player_identities_provider_check` IN (DISCORD, STEAM); novo provider exige migration |
| `provider_subject` | varchar(128) | opaco: trim, 1–128, Unicode válido, sem C0/C1, nunca interpretado; `player_identities_subject_check` exige não vazio |
| `created_at`, `updated_at` | timestamptz | default `now()` |

`player_identities_provider_subject_key UNIQUE (provider, provider_subject)` é a
garantia final de que uma identidade externa pertence a um único player. O mesmo
subject textual em providers diferentes são identidades distintas.

Não há colunas de senha, e-mail, token OAuth, avatar ou outro dado pessoal, nem
FK/coluna relacionada a `staff_users` ou `staff_sessions`.

`PlayerAccountService` (interno, para a 10.3):

- `createPlayer({ displayName, identity? })`: cria player ACTIVE e, opcionalmente,
  a primeira identidade na mesma transação. Identidade já vinculada → 409 com
  rollback do player.
- `findPlayerById(id)`: UUID inválido → 400; inexistente → `null`.
- `findByIdentity(provider, providerSubject)`: player ou `null`.
- `attachIdentity(playerId, identity)`: lock do player, `INSERT … ON CONFLICT DO
  NOTHING` na constraint única e releitura. Mesmo player → idempotente; outro
  player → 409; player inexistente → 404.

Concorrência é resolvida pelo PostgreSQL, sem mutex em memória. Erros de validação
não ecoam o subject, e o módulo não registra logs. Status não tem enforcement nesta
subetapa: SUSPENDED/BANNED só produzirão efeito a partir da 10.3.

### Characters

- **1 player : N characters.**
- **Escopo por `gameServerId`**: a mesma string em outro servidor é outro character.
- **`characterExternalId` opaco**, com as mesmas regras dos IDs de Character atuais.
- Posse **PENDING / VERIFIED / REVOKED**; só vira VERIFIED após confirmação do
  jogo/Agent. O backend nunca marca VERIFIED por declaração do player ou do Electron.
- Um character verificado pertence a no máximo um player por servidor.
- **Sem limite inicial de slots.**
- **Criação de personagem continua fora do backend.** O backend registra e verifica
  vínculos; não cria characters.

#### Implementação (10.4)

Módulo `src/player-characters/`. Ownership é domínio do backend, confirmado por
evento confiável do Agent: nenhuma GameCommand é criada e não há endpoint de Agent.

`player_characters`:

| Coluna | Regra |
| --- | --- |
| `id` | uuid PK |
| `player_id` | FK `players` |
| `game_server_id` | FK `game_servers` |
| `character_external_id` | varchar(128), opaco (trim, 1–128, sem controles), nunca interpretado |
| `status` | `PENDING` / `VERIFIED` / `REVOKED`, default `PENDING` |
| `verified_at`, `revoked_at` | coerentes com o status (`player_characters_lifecycle_check`) |
| `created_at`, `updated_at` | timestamps |

- `player_characters_link_key UNIQUE (player_id, game_server_id, character_external_id)`:
  um vínculo por player/servidor/character; relink reutiliza a linha.
- `player_characters_verified_key UNIQUE (game_server_id, character_external_id)
  WHERE status = 'VERIFIED'`: no máximo um dono verificado por character.
- Lifecycle: PENDING exige `verified_at` e `revoked_at` nulos; VERIFIED exige
  `verified_at`; REVOKED exige `revoked_at` e preserva `verified_at` se houve
  verificação.

`player_character_link_challenges`: `id`, `player_character_id` (FK),
`challenge_hash` (SHA-256 hex, único), `expires_at`, `consumed_at`, `revoked_at`,
`created_at`. `player_character_link_challenges_active_key` garante no banco no
máximo um challenge não consumido e não revogado por vínculo; consumido e revogado
são mutuamente exclusivos.

**Challenge:** 13 caracteres de `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sem 0/O, 1/I/L),
≈ 64 bits via `crypto.randomInt`, exibido como `XXXX-XXXX-XXXXX`. Aceita espaços,
hífens e minúsculas ao ser digitado. Vale `PLAYER_LINK_CHALLENGE_TTL` (padrão 10m,
de 1m a 1h) e é de uso único. Só o hash do formato canônico é persistido; o
plaintext aparece apenas na resposta do POST. Um novo pedido revoga o challenge
ativo anterior na mesma transação.

**Lifecycle**

```text
(novo) ─ POST ─► PENDING ─ confirmFromAgent ─► VERIFIED
                  │  ▲                            │
             revoke  └──── POST (relink) ◄── REVOKED ◄─ revoke
```

**Player API** (`PlayerAuthGuard`; o player vem sempre do token):

| Rota | Efeito |
| --- | --- |
| `POST /api/v1/player/character-links` `{ gameServerId, characterExternalId }` | 201; cria ou reabre o vínculo PENDING e devolve `challenge` + `challengeExpiresAt` (única vez). Rate limited como a Player Auth |
| `GET /api/v1/player/character-links/:linkId` | vínculo do próprio player; de outro player ou inexistente → 404 |
| `POST /api/v1/player/character-links/:linkId/revoke` | PENDING/VERIFIED → REVOKED; já REVOKED → 200 sem mudança nem Audit |

Erros: servidor inexistente 404; desabilitado 409; character VERIFIED por outro
player → 409 `Character unavailable` (sem revelar o dono); vínculo próprio já
VERIFIED → 409. Body não aceita `playerId`, `status` ou `challenge`. A listagem de
characters (`/player/me/characters`) é da 10.6.

**Relink:** um vínculo REVOKED do mesmo player volta a PENDING (`verified_at` e
`revoked_at` zerados) com novo challenge. Ownership nunca é transferida
automaticamente: outro player só verifica depois que o dono revoga.

**Ownership policy:** `CharacterOwnershipService.findVerifiedOwnership` /
`requireVerifiedOwnership(playerId, gameServerId, characterExternalId, manager?)`
para as subetapas 10.5+. Responde 404 `Character not available` para
não verificado, de outro player ou inexistente. O `playerId` deve vir do
`PlayerActor` autenticado. Status da conta é responsabilidade do guard.

**Confirmação pelo Agent:** `CharacterLinkService.confirmFromAgent({ challenge,
gameServerId, characterExternalId })` é exportado para o transporte autenticado
da Etapa 11 e não tem rota HTTP. Em uma transação, com lock do vínculo e depois
do challenge:

1. localiza o challenge pelo hash;
2. rejeita consumido, revogado ou expirado;
3. confere servidor e character do vínculo;
4. exige servidor habilitado e player ACTIVE (relido do banco);
5. exige que nenhum outro vínculo esteja VERIFIED para o character;
6. consome o challenge, marca VERIFIED com `verified_at` e audita.

Resultado tipado: `VERIFIED`, `ALREADY_VERIFIED` (replay do mesmo challenge para o
mesmo vínculo ainda VERIFIED, sem efeitos) ou `REJECTED` com `INVALID_CHALLENGE`,
`EXPIRED_CHALLENGE`, `CHALLENGE_MISMATCH`, `PLAYER_UNAVAILABLE`,
`SERVER_UNAVAILABLE` ou `CHARACTER_UNAVAILABLE`. Rejeições não alteram nada; um
mismatch não consome o challenge. Perdedor de corrida no índice VERIFIED recebe
`CHARACTER_UNAVAILABLE`. Nenhum fake existe em produção; só testes chamam o serviço.

**Status da conta:** o guard bloqueia SUSPENDED/BANNED nas rotas; a confirmação
relê o player e não verifica para contas bloqueadas. Suspender não revoga vínculos
existentes (decisão administrativa futura).

**Audit** (atômico com a mudança de estado; `resourceType = PLAYER_CHARACTER`,
`resourceId = linkId`):

| Action | Actor | Metadata |
| --- | --- | --- |
| `PLAYER_CHARACTER_LINK_REQUESTED` | PLAYER | linkId, gameServerId, characterExternalId, status, relink |
| `PLAYER_CHARACTER_LINK_VERIFIED` | SYSTEM:AGENT | linkId, gameServerId, characterExternalId, playerId |
| `PLAYER_CHARACTER_LINK_REVOKED` | PLAYER | linkId, gameServerId, characterExternalId, previousStatus |

Nunca entram challenge, hash, providerSubject ou tokens.

**Concorrência:** locks de linha no PostgreSQL (vínculo antes de challenge) e os
índices únicos são a garantia: confirmações simultâneas do mesmo challenge geram
um efeito; dois players no mesmo character geram um VERIFIED; pedidos simultâneos
do mesmo player geram um vínculo e um challenge ativo; revoke e confirm
concorrentes terminam em estado coerente.

### Character Profile + Skills (10.5)

Queries do Skyrim pedidas pelo player. **O Skyrim continua sendo a fonte de
verdade:** o backend valida e devolve o resultado do command; não existem
snapshots, read-models ou cache. Contratos em
`src/player-character-operations/character-profile.contracts.ts`, registrados no
catálogo do Game Bridge (32 tipos) e fora de `CHARACTER_COMMAND_TYPES`: não são
operações staff de Character Management e `/character-operations/:id` responde 404
para eles.

| CommandType | Payload | Result |
| --- | --- | --- |
| `CHARACTER_PROFILE_QUERY` | `{ characterId }` | `{ characterId, name, level, race, sex, health, magicka, stamina }` |
| `CHARACTER_SKILLS_QUERY` | `{ characterId }` | `{ characterId, skills: { <18 skills> } }` |

- `characterId`, `name` e `race`: strings opacas (trim, 1–128, sem controles);
  `race` não é interpretada (por exemplo, editor ID ou FormID do Agent).
- `level`: inteiro de 1 a 65535 (uint16 no Skyrim).
- `sex`: `MALE` ou `FEMALE`.
- `health`, `magicka`, `stamina`: valor atual do atributo, número finito de 0 a
  1.000.000 (pode ser fracionário).
- `skills`: exatamente `alchemy`, `alteration`, `archery`, `block`, `conjuration`,
  `destruction`, `enchanting`, `heavyArmor`, `illusion`, `lightArmor`,
  `lockpicking`, `oneHanded`, `pickpocket`, `restoration`, `smithing`, `sneak`,
  `speech`, `twoHanded`; cada uma inteira de 0 a 100 (nível base, sem
  modificadores temporários). Skill ausente, desconhecida, fracionária ou fora da
  faixa é rejeitada.
- Campos extras, tipos errados, `characterId` divergente do payload e resultados
  acima de 65536 bytes são rejeitados pelo receiver; o command não conclui.

**Player API** (`PlayerAuthGuard`):

| Rota | Resposta |
| --- | --- |
| `POST /api/v1/player/game-servers/:gameServerId/characters/:characterId/profile-query` | 202 + `Location` |
| `POST /api/v1/player/game-servers/:gameServerId/characters/:characterId/skills-query` | 202 + `Location` |
| `GET /api/v1/player/character-operations/:operationId` | detalhe do próprio player |

- `Idempotency-Key` obrigatório; body vazio (qualquer campo → 400).
- Ownership: dentro da transação do command, após o lock do servidor,
  `requireVerifiedOwnership(playerId do token, gameServerId, characterId)`.
  PENDING, REVOKED, de outro player ou inexistente → 404 `Character not available`;
  retries também são reautorizados. Servidor inexistente 404, desabilitado 409.
  Para isso o `ActorCommandService.create` ganhou um hook opcional `authorize`,
  executado na mesma transação; os chamadores staff não mudaram.
- Ator PLAYER e scope `PLAYER:<playerId>`: retry do mesmo player devolve o mesmo
  command, conteúdo diferente com a mesma chave → 409, outro player com a mesma
  chave cria command independente.
- 202 significa apenas aceito e persistido. O dispatch segue o fluxo existente do
  Game Bridge após o commit (dispatcher explícito, sem scheduler); servidor
  offline/stale aceita PENDING. Sem Agent real (Etapa 11), nenhum resultado chega
  em produção.
- Referência: `{ operationId, type, gameServerId, characterId, status, createdAt }`.
  Detalhe acrescenta `completedAt` e `result: { outcome, data, errorCode,
  receivedAt } | null`, com `data` revalidado pelo contrato; FAILED/TIMEOUT têm
  `data: null`. O detalhe só encontra commands desses dois tipos com
  `requested_by_player_id` do player autenticado; qualquer outro → 404.
- Nunca expostos: `requestedByStaffId`, `requestedByPlayerId`, `idempotencyScope`,
  `idempotencyKey`, `correlationId`, lease, deadlines, tentativas, conexão e payload.
  `/game-commands` (admin) continua com seu allowlist, sem payload nem resultado.
- Queries não geram Audit, como no padrão staff; o GameCommand é a trilha.

### Multiple Characters (10.6)

Um player possui N characters (1:N), cada um identificado por `gameServerId` +
`characterExternalId`. Não há limite de slots; as constraints da 10.4 continuam
sendo a garantia de unicidade. **Não existe character "selecionado" ou "ativo"
no servidor:** toda operação indica explicitamente o character, e o Electron
escolhe localmente um VERIFIED para consultar profile/skills (10.5).

| Rota | Resposta |
| --- | --- |
| `GET /api/v1/player/me/characters?page&limit` | `{ items, total, page, limit, totalPages }` |
| `GET /api/v1/player/me/characters/:characterLinkId` | um item |

Item: `{ id, gameServer: { id, code, name, enabled }, characterId, status,
verifiedAt, createdAt }`, em que `id` é o id do vínculo e `enabled` é apenas o flag
administrativo do servidor (sem health ou conexão).

- Somente vínculos do player do token, com status PENDING ou VERIFIED. REVOKED não
  aparece na listagem nem no detalhe e permanece no banco como histórico.
  Detalhe de outro player, REVOKED ou inexistente → 404 `Character not found`.
- PENDING aparece, mas continua rejeitado por `requireVerifiedOwnership` e pelas
  queries da 10.5.
- Um character de servidor desabilitado continua listado: `disabled` não encerra
  ownership.
- Ordenação: VERIFIED antes de PENDING, depois `createdAt` ASC e `id` ASC.
- Paginação: o mesmo contrato `page` (padrão 1) / `limit` (padrão 20, máximo 100)
  das consultas administrativas. Qualquer outro parâmetro (por exemplo `playerId`
  ou `status`) → 400.
- Uma consulta com join em `game_servers`, sem N+1. Leitura pura: nenhuma
  GameCommand, lock ou Audit.
- Não retorna `playerId`, `revokedAt`, challenge, hash, identidade do provider,
  dados de GameCommand nem dados de runtime (nome, nível, raça, atributos, skills,
  inventário, propriedades, profissão), que não são persistidos no backend.

### Professions

- Domínio incluído no MVP.
- **Uma profissão ativa por CHARACTER**, não por conta de player.
- O vínculo é feito pela identidade do character (`gameServerId` +
  `characterExternalId`) e exige ownership VERIFIED para ações do player.
- Cada character do mesmo player pode ter sua própria profissão.
- **XP e nível pertencem ao character.** Revogar ou transferir a ownership não
  move XP para a conta do player.
- Opções iniciais: **TAILOR, HUNTER, MINER, BLACKSMITH, ALCHEMIST,
  CHARCOAL_BURNER, COOK**.
- O **backend persiste profissão, XP e nível**.
- **XP nunca é concedido pelo próprio Player/Electron.** XP confiável vem de
  SYSTEM/Agent, por contrato próprio, idempotente e auditado.
- **Troca de profissão desabilitada inicialmente** até existir regra oficial.

### Groups

- Domínio do backend.
- Party com **leader, members e invites**.
- **Primeiro domínio a publicar e consumir eventos realtime** (10.8): convites,
  entrada/saída e troca de leader geram eventos internos entregues aos membros.

### Guilds / Clans

- Domínio persistente próprio.
- **Guild/clan não é Skyrim Faction.** Os contratos `CHARACTER_FACTION_*`
  administrativos não são reutilizados como guilda.
- Membros, cargos e convites.
- Integração com o jogo pode existir depois, sem mudar o modelo do backend.

### Economy / Wallet

- **O ledger do backend é a fonte de verdade econômica.**
- **Gold do Skyrim não é usado como banco transacional.**
- **Wallet é derivada de ledger imutável** (lançamentos append-only; saldo nunca é
  campo editável isolado).
- O Agent pode refletir efeitos no jogo, sem ser a autoridade do saldo.
- **Nenhuma mutation do Electron altera saldo diretamente.** Toda variação de saldo
  é consequência de uma operação de domínio (trade, marketplace, SYSTEM) que gera
  lançamentos.

### Trade

Dois tipos de ativo são suportados arquiteturalmente: **LEDGER_CURRENCY** e
**GAME_ITEM**.

- **Escrow/reservas** para todos os ativos envolvidos, criadas antes de qualquer
  liquidação.
- **Não depender de duas GameCommands sem coordenação.**
- **Nenhuma operação duplica item ou saldo**; todo passo é idempotente por ator e
  retries retornam o mesmo estado.

**LEDGER_CURRENCY**

- Settlement **inteiramente transacional no backend**: reservas, lançamentos e
  liberação ocorrem na mesma transação PostgreSQL, ou nenhum.

**GAME_ITEM**

- O backend mantém proposta, reserva e **escrow lógico** do item.
- A **transferência real exige confirmação do Agent**.
- Estado explícito **AWAITING_GAME_CONFIRMATION** enquanto a transferência física
  não é confirmada. Somente a confirmação confiável do Agent conclui o settlement.
- **Antes da integração real, a transferência física nunca é marcada como
  concluída**; com gateway Disconnected a operação permanece aguardando ou falha
  explicitamente, sem sucesso simulado.
- Confirmações repetidas do Agent são idempotentes e não reaplicam efeitos.
- Em trade misto (moeda por item), a parte LEDGER_CURRENCY fica reservada e só é
  liquidada junto com a confirmação do GAME_ITEM; falha ou cancelamento libera as
  reservas sem lançamento duplicado.

A Etapa 10 constrói o domínio, os estados e os contratos. A **Etapa 11**
implementa a integração real necessária para o settlement de GAME_ITEM.

### Marketplace

- Listings persistidos.
- Construído sobre wallet, ledger e escrow.
- Segue **as mesmas regras de custódia do Trade** para LEDGER_CURRENCY e GAME_ITEM,
  inclusive AWAITING_GAME_CONFIRMATION para itens.
- **Nenhuma duplicação de saldo ou item por retries**: toda mutation é idempotente
  por ator e liquidada uma única vez.

### Chat

- Faz parte do MVP.
- Arquitetura **event/realtime**, reutilizando a infraestrutura WebSocket da 10.8.
- Retenção e configuração detalhadas podem evoluir.

### Realtime

- **WebSocket é o transporte realtime oficial do backend.**
- A infraestrutura começa na **10.8 Groups + Realtime Foundation**; Groups é o
  primeiro domínio a publicar e consumir eventos, e Chat reutiliza a mesma base.
- **Electron e Admin Web são consumidores.** Conexões são autenticadas com o token
  da respectiva superfície (Player ou Staff), sem aceitar um no lugar do outro.
- **Domínios não dependem do framework WebSocket**: publicam eventos internos
  tipados, e a camada realtime os transporta aos destinatários autorizados.
- Realtime não é fonte de verdade: o estado vive nos serviços de domínio e o
  cliente consegue reconstruí-lo pela API HTTP.

### Properties / Houses / Holds e Horses / Mounts

- **Reutilizar contratos Character existentes para leitura**
  (`CHARACTER_PROPERTIES_QUERY`, `CHARACTER_HOLDS_QUERY`, `CHARACTER_HORSES_QUERY`).
- A **Player API usa ownership VERIFIED em vez de Staff permission**.
- Mutations administrativas (grant/revoke/give) continuam exclusivas da Admin API.

### VIP

- **Reutilizar `vip_offers`**; o Electron consome
  `GET /api/v1/vip-store/offers[/:code]`.
- **Não duplicar o catálogo.**
- A integração do player adiciona **entitlement, order e delivery**, referenciando
  `vip_offers.id` e `players.id`, com entrega pelo ator SYSTEM.

### Electron

- Consome **Player API + realtime**.
- **O backend não depende de Electron.**
- O **Launcher C#** continua cuidando de mods, arquivos, atualização e abertura do
  jogo. Configurações locais do cliente nunca entram em Player Settings.

### SKSE / Agent

- **Fonte de verdade do runtime Skyrim.**
- Responsável futuramente por **confirmar ownership**, **emitir eventos confiáveis**
  (por exemplo, base para concessão de XP de profissão) e **confirmar
  transferências de GAME_ITEM**.
- Até a Etapa 11 os gateways permanecem Disconnected: nenhum estado dependente do
  Agent (ownership VERIFIED, XP concedido, GAME_ITEM transferido) é produzido por
  simulação em produção.

## Actor model

Ator genérico: **STAFF | PLAYER | SYSTEM**.

- STAFF: `staff_users.id`.
- PLAYER: `players.id`.
- SYSTEM: processos internos e eventos confiáveis do Agent (ex.: XP, entrega VIP),
  sem usuário humano.

Audit e GameCommand suportam o ator genérico **sem quebrar dados Staff existentes**
(10.2):

- linhas atuais continuam válidas e são interpretadas como STAFF;
- colunas e FKs de staff existentes não são removidas nem reinterpretadas;
- consultas de Audit atuais (`AUDIT_READ`) mantêm contrato e resultados;
- Audit continua append-only; nenhuma migration faz UPDATE em `audit_logs`
  (o trigger de imutabilidade rejeitaria);
- cada linha identifica exatamente um tipo de ator, verificado por constraint;
- metadata continua allowlist; nenhum dado pessoal do provider entra no Audit.

### Implementação (10.2)

Contrato interno fechado em `src/actors/actor.contracts.ts`:

```ts
type Actor =
  | { type: 'STAFF'; id; username; displayName; roleName } // snapshot da sessão staff
  | { type: 'PLAYER'; playerId }                          // UUID de players, minúsculo
  | { type: 'SYSTEM'; source: 'AGENT' | 'PROFESSION' | 'VIP_DELIVERY' };
```

`actor()` valida e copia com campos fechados por tipo: PLAYER não aceita role,
permissions ou source; SYSTEM só aceita a allowlist. Nenhum endpoint recebe actor:
STAFF vem da sessão autenticada, PLAYER virá da sessão de player (10.3) e SYSTEM
somente de código do servidor. Nova source exige alteração do enum e das CHECKs.

**GameCommand** (colunas novas):

| Coluna | Regra |
| --- | --- |
| `actor_type` | NOT NULL, default `STAFF` |
| `requested_by_staff_id` | existente, FK `staff_users`, nullable (commands internos sem autoria) |
| `requested_by_player_id` | nullable, FK `game_commands_player_fkey` → `players(id)`, índice `game_commands_player_idx` |
| `requested_by_system_source` | nullable, allowlist |
| `idempotency_scope` | NOT NULL, default `STAFF`; interno |

`game_commands_actor_check` exige exatamente uma forma:
STAFF (sem player/source, scope `STAFF`), PLAYER (player, sem staff/source, scope
`PLAYER:<player_id>`) ou SYSTEM (source da allowlist, sem staff/player, scope
`SYSTEM:<source>`). O scope é derivado do ator e conferido pelo banco; não pode
divergir da autoria.

**Audit** (colunas novas, todas nullable, sem FK — como `actor_staff_id`, o
histórico sobrevive às linhas de origem): `actor_type`, `actor_player_id` (índice
`audit_logs_actor_player_idx`) e `actor_system_source`.
`audit_logs_actor_check` aceita:

- `actor_type` NULL sem player/source: linhas históricas (STAFF quando
  `actor_staff_id` existe) e eventos sem ator;
- STAFF com `actor_staff_id`;
- PLAYER somente com `actor_player_id` — `actor_role`, username, displayName e
  staff id obrigatoriamente NULL;
- SYSTEM somente com `actor_system_source` da allowlist.

Linhas antigas não foram reescritas: a migration só adiciona colunas nullable e
constraints, o trigger `audit_logs_immutable` continua ALWAYS. Novas linhas staff
gravam `actor_type = STAFF`. A API de Audit expõe `actorType` (derivado para
linhas históricas), `actorPlayerId` e `actorSystemSource`; `actorRole` é sempre
null fora de STAFF. Nenhum dado de `player_identities` entra no Audit.

**Serviço compartilhado:** `ActorCommandService.create(input, actor, audit?)`
(`src/actor-operations/`) concentra lock do servidor, 409 para servidor
desabilitado, insert idempotente com scope, Audit atômico com o ator e retorno
`{ command, created }`. Não concede nada: autorização (RBAC ou ownership) é do
chamador. `AdministrativeCommandService` virou wrapper Staff (permission →
`staffActor`) com a mesma API; Character, Moderation e World não conhecem Player.
O dispatch continua separado, após o commit.

## Idempotência

- **Idempotência de Player é isolada por ator.** A chave de um player só pode
  colidir com chaves do próprio player.
- **`UNIQUE(game_server_id, idempotency_key)` global nunca é reutilizada para
  players.** Um replay nunca devolve, confirma ou revela operação de outro ator
  (nem por 409).
- Mesma chave e mesmo conteúdo → mesma operação; conteúdo diferente → 409;
  concorrência resolvida por constraint no PostgreSQL, sem mutex em memória.
- Ledger, trade e marketplace aplicam a mesma regra: um retry nunca gera segundo
  lançamento, segunda reserva ou segunda liquidação.
- A semântica atual entre staff permanece inalterada.

### Idempotency scope (10.2)

`UNIQUE (game_server_id, idempotency_scope, idempotency_key)` substitui a
constraint global (mesmo nome, `game_commands_idempotency_key`).

| Ator | Scope | Efeito |
| --- | --- | --- |
| STAFF (todos) e submits internos sem autoria | `STAFF` | Compartilhado, como antes: replay equivalente de outro staff devolve o mesmo command e preserva a autoria original |
| PLAYER | `PLAYER:<playerId>` | Isolado: outro player com a mesma chave cria command independente, sem 409 nem leitura cruzada |
| SYSTEM | `SYSTEM:<source>` | Isolado por source |

Commands existentes receberam `actor_type = STAFF` e `idempotency_scope = STAFF`
pelo default das colunas, sem perda ou recriação de histórico. Todas as buscas de
replay usam `(servidor, scope, chave)`. O scope nunca aparece em respostas HTTP;
`/game-commands` segue com o mesmo allowlist de campos. O envelope do bridge não
mudou: o Agent deve deduplicar por `commandId`, como já documentado.

`down` da migration recusa a reversão se houver commands ou Audit PLAYER/SYSTEM
(chaves isoladas colidiriam na constraint antiga e a autoria seria perdida);
nada é apagado.

## Decisões ainda abertas

Detalhes que não bloqueiam a fundação e podem ser fixados na subetapa do domínio:

| Tema | Subetapa |
| --- | --- |
| Fórmula de XP e níveis de profissão | 10.7 |
| Regras de troca de profissão | 10.7 (permanece desabilitada até definição) |
| Tamanho máximo de group | 10.8 |
| Cargos de guild e suas capacidades | 10.9 |
| Taxas de marketplace | 10.14 |
| Retenção de chat | 10.15 |
| Moeda/denominação apresentada ao jogador | 10.12 |

Pontos de implementação a fixar no início da subetapa correspondente, sem alterar
as decisões acima:

| Tema | Subetapa |
| --- | --- |
| Efeito de SUSPENDED/BANNED em trade e marketplace; revogação administrativa de vínculos | 10.13 / 10.14 / futura |
| Transporte autenticado do Agent chamando `confirmFromAgent` e digitação do challenge no jogo | 11 |
| Implementação real de perfil e skills pelo Agent, conforme os contratos da 10.5 | 11 |
| Chaves de Player Settings | 10.16 |
| Rate limiting distribuído, confiança em proxy e cotas por conta | Etapa 12 |
