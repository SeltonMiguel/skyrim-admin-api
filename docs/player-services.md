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
| 10.7 Professions | **Implementada.** `character_professions`, `profession_experience_events`, seleção única pela Player API, `grantFromAgent` interno; migration `1789930000000-Professions` |
| 10.8 Groups + Realtime Foundation | **Implementada.** Groups (party, invites), `RealtimeEventBus`, WebSocket em `/api/v1/realtime`; migration `1789940000000-PlayerGroups` |
| 10.9 Guilds / Clans | **Implementada.** Guildas persistentes do character identity (MASTER/OFFICER/MEMBER, convites, limite provisório de 50), eventos no realtime da 10.8; migration `1789950000000-PlayerGuilds` |
| 10.10 Properties / Houses / Holds | **Implementada.** `properties-query` e `holds-query` read-only sobre `CHARACTER_PROPERTIES_QUERY`/`CHARACTER_HOLDS_QUERY` existentes, por ownership VERIFIED; sem migration |
| 10.11 Horses / Mounts | **Implementada.** `horses-query` read-only sobre `CHARACTER_HORSES_QUERY` existente, por ownership VERIFIED; sem migration |
| 10.12 Economy / Wallet | **Implementada.** Ledger de partidas dobradas imutável (GOLD inteiro) do character identity, balances como projeção, credit/debit SYSTEM e transfer internos, wallet read-only; migration `1789960000000-Economy` |
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

#### Implementação (10.7)

Módulo `src/professions/`. Domínio do backend: nenhuma GameCommand.

**Pertence ao character, não ao vínculo:** a identidade da profissão é
`game_server_id` + `character_external_id`, a mesma do jogo. Cada character do
mesmo player tem a sua. O vínculo de ownership apenas autoriza o acesso: se a
ownership de A for revogada e B verificar o mesmo character, B enxerga a mesma
profissão, XP e nível (nenhum fluxo de transferência foi implementado; o modelo
apenas não perde progressão).

`character_professions`: `id`, `game_server_id` (FK `game_servers`),
`character_external_id` (varchar(128), não vazio), `profession` (check das 7),
`experience` (bigint, 0 a 1.000.000.000.000), `level` (1–100), `created_at`,
`updated_at`, com `UNIQUE (game_server_id, character_external_id)`: uma profissão
por character. `character_professions_progression_check` garante no banco, só com
aritmética inteira, que o nível corresponde ao XP.

`profession_experience_events`: `id`, `character_profession_id` (FK),
`game_server_id` (FK), `external_event_id` (opaco, 1–128), `amount` (1–1.000.000),
`created_at`, com `UNIQUE (game_server_id, external_event_id)`. O protocolo do
Agent da Etapa 11 deve emitir `eventId` único dentro de cada GameServer.

**Catálogo fechado:** TAILOR, HUNTER, MINER, BLACKSMITH, ALCHEMIST,
CHARCOAL_BURNER, COOK (enum + check; sem tabela configurável).

**Progressão** (`ProfessionProgressionPolicy`, apenas inteiros): XP acumulado para
o nível N é `100 * (N - 1)^2` (1 = 0, 2 = 100, 3 = 400, 4 = 900, 5 = 1600, 100 =
980100). O nível é o maior N cujo threshold é ≤ XP, limitado a 100.
`nextLevelExperience` = threshold do próximo nível, ou `null` no nível 100.
Semântica escolhida: o XP continua acumulando depois do nível 100 e satura no teto
seguro de 1.000.000.000.000 (muito abaixo de `Number.MAX_SAFE_INTEGER`).

**Player API** (`PlayerAuthGuard` + vínculo próprio VERIFIED; PENDING, REVOKED, de
outro player ou inexistente → 404 `Character not found`):

| Rota | Comportamento |
| --- | --- |
| `GET /api/v1/player/me/characters/:characterLinkId/profession` | estado atual, ou `{ characterLinkId, profession: null }` |
| `POST /api/v1/player/me/characters/:characterLinkId/profession` `{ profession }` | 201 na primeira seleção; 200 repetindo a mesma (sem Audit); 409 `PROFESSION_ALREADY_SELECTED` para outra |

O serviço carrega o vínculo pedido, exige que seja do player autenticado e esteja
VERIFIED, e usa o `gameServerId` + `characterExternalId` desse vínculo para
localizar ou criar a profissão; o character nunca vem da request.

Resposta: `{ characterLinkId, profession, level, experience, nextLevelExperience }`.
O body aceita somente `profession`; XP, nível, `playerId` e campos extras → 400.
Troca de profissão não existe. Não retorna `playerId` nem `characterExternalId`.

**XP confiável:** `ProfessionExperienceService.grantFromAgent({ gameServerId,
characterExternalId, eventId, amount })` é exportado para o transporte do Agent
(Etapa 11); não há rota HTTP de XP. O Agent identifica o character como o conhece,
que é a própria identidade da profissão. Em uma transação:

1. valida entrada (UUID, ids opacos, `amount` inteiro de 1 a 1.000.000);
2. localiza e trava a profissão por servidor + character;
3. se existe dono VERIFIED atual, exige que ele esteja ACTIVE;
4. insere o evento com `ON CONFLICT DO NOTHING`;
5. evento novo: soma XP, recalcula o nível e audita;
6. replay (mesmo evento, mesma profissão e amount): `ALREADY_APPLIED` com o estado
   atual, sem somar nem auditar; mesmo id com outro conteúdo: `EVENT_CONFLICT`.

Resultado: `GRANTED` / `ALREADY_APPLIED` com o estado, ou `REJECTED` com
`INVALID_INPUT`, `PROFESSION_NOT_SELECTED`, `PLAYER_UNAVAILABLE` ou
`EVENT_CONFLICT`. Rejeições não alteram nada. O estado retornado é
`{ gameServerId, characterExternalId, profession, level, experience,
nextLevelExperience }`.
**Character cujo dono VERIFIED está SUSPENDED/BANNED não recebe XP** (MVP). Sem
dono verificado no momento, o XP continua sendo registrado, porque o progresso é
do character.

**Audit** (atômico com a mutation, `resourceType = CHARACTER_PROFESSION`):

| Action | Actor | Metadata |
| --- | --- | --- |
| `PROFESSION_SELECTED` | PLAYER | playerCharacterId (vínculo que autorizou), gameServerId, characterExternalId, profession, level |
| `PROFESSION_EXPERIENCE_GRANTED` | SYSTEM:AGENT | gameServerId, characterExternalId, profession, amount, previousLevel, newLevel, externalEventId |

**Concorrência:** a seleção trava o vínculo e usa
`UNIQUE (game_server_id, character_external_id)` com `ON CONFLICT`; seleções simultâneas geram uma linha e só uma profissão vence. Cada
concessão trava a linha de profissão: replays simultâneos aplicam uma vez e
eventos distintos simultâneos acumulam sem lost update.

Integração real do Agent (eventos de XP e seu transporte) fica para a Etapa 11.

### Groups

- Domínio do backend.
- Party com **leader, members e invites**.
- **Primeiro domínio a publicar e consumir eventos realtime** (10.8): convites,
  entrada/saída e troca de leader geram eventos internos entregues aos membros.

#### Implementação (10.8)

Módulo `src/player-groups/`. Group é uma party temporária do **ownership atual**:
membros são vínculos `player_characters`, então um novo dono do character não
herda o group anterior. Todos os membros estão no mesmo GameServer.

| Tabela | Colunas e garantias |
| --- | --- |
| `player_groups` | `id`, `game_server_id` (FK), `status` ACTIVE/DISBANDED, `created_at`, `updated_at`, `disbanded_at` (presente sse DISBANDED) |
| `player_group_members` | `id`, `group_id` (FK), `player_character_id` (FK), `role` LEADER/MEMBER, `joined_at`, `left_at`; índice único parcial de **uma membership ativa por vínculo** e de **um leader ativo por group**; histórico nunca apagado |
| `player_group_invites` | `id`, `group_id`, `target_player_character_id`, `invited_by_player_character_id` (FKs), `status` PENDING/ACCEPTED/DECLINED/CANCELLED/EXPIRED, `expires_at`, `responded_at` (nulo sse PENDING), `created_at`; índice único parcial de um PENDING por group + target |

- Máximo **provisório de 5 membros** (leader + 4) em `MAX_GROUP_MEMBERS`; a
  capacidade é verificada sob o lock do group, então alterar o valor não exige
  migration.
- Convites valem `PLAYER_GROUP_INVITE_TTL` (padrão 10m, de 1m a 24h). A expiração é
  detectada ao usar ou repetir o convite, que passa a EXPIRED.
- O leader existe desde a criação (mesma transação) e sair como leader desfaz o
  group; o banco garante no máximo um leader ativo.

**Lifecycle:** create (ACTIVE + LEADER) → invites → accept/decline → leave/kick →
disband (explícito ou saída do leader). Disband marca DISBANDED, fecha todas as
memberships (`left_at`) e cancela convites PENDING.

**Player API** (`PlayerAuthGuard`; o player vem do token; vínculos do ator precisam
ser próprios e VERIFIED, senão 404 `Character not found`):

| Rota | Regra |
| --- | --- |
| `POST /api/v1/player/groups` `{ characterLinkId }` | 201; character sem group ativo, servidor habilitado |
| `GET /api/v1/player/groups/:groupId` | só membros ativos; outros → 404 |
| `POST .../:groupId/invites` `{ actorCharacterLinkId, targetCharacterId }` | leader apenas (membro → 403, não membro → 404); target resolvido pelo servidor do group; não resolvido → 404 `Character not available`; já em group → 409 `Character unavailable`; group cheio → 409. Repetir convite pendente → 200 com o mesmo convite |
| `GET /api/v1/player/group-invites` | convites PENDING e não expirados para characters próprios |
| `POST /api/v1/player/group-invites/:inviteId/accept` | só o dono do target; PENDING, não expirado, group ACTIVE, vaga livre, target ainda sem group |
| `POST .../:inviteId/decline` | só o dono do target |
| `POST .../:groupId/leave` `{ characterLinkId }` | MEMBER sai; LEADER desfaz o group |
| `POST .../:groupId/members/:memberId/kick` | leader apenas; não pode expulsar a si mesmo (400) |
| `POST .../:groupId/disband` | leader apenas |

**Identificação de outros characters:** internamente, memberships e convites usam
`player_character_id` (FK para o vínculo de ownership). Esse UUID é privado: a
Player API referencia characters de outros players apenas pelo
`characterExternalId` (id opaco do jogo), escopado pelo servidor. No convite, o
body traz `targetCharacterId`; o servidor vem do group, e o backend procura o
vínculo VERIFIED com `game_server_id` + `character_external_id`, usando o id
encontrado só internamente. Character inexistente, PENDING, REVOKED ou de outro
servidor responde o mesmo 404. `targetCharacterLinkId`, `targetPlayerId` e
`gameServerId` no body → 400. **Conhecer um `characterExternalId` não é prova de
ownership** nem dá acesso a APIs protegidas.

O group retornado lista os membros ativos como `{ memberId, characterId, role,
joinedAt, characterLinkId }`, em que `characterId` é o `characterExternalId` e
`characterLinkId` só é preenchido para characters do próprio player (null para os
demais). O convite é `{ inviteId, groupId, gameServerId, targetCharacterId,
invitedByCharacterId, status, expiresAt, createdAt, respondedAt }`, sem FKs
internas. Eventos realtime seguem a mesma regra (`targetCharacterId`). Nenhum
`playerId` ou identidade de provider aparece.

**Concorrência:** ordem de locks group → vínculos → memberships/convites. Criação
trava o vínculo; accept trava group, convite e vínculo alvo; capacidade é contada
sob o lock do group. Os índices parciais são a garantia final: criações simultâneas
geram um group, dois accepts pela última vaga admitem um, um character não entra
em dois groups e accept × disband termina em estado coerente.

**Audit** (actor PLAYER, `resourceType = PLAYER_GROUP`, metadata com `groupId`,
`gameServerId` e ids de vínculo/membro/convite): `PLAYER_GROUP_CREATED`,
`PLAYER_GROUP_INVITED`, `PLAYER_GROUP_INVITE_ACCEPTED`,
`PLAYER_GROUP_INVITE_DECLINED`, `PLAYER_GROUP_MEMBER_LEFT`,
`PLAYER_GROUP_MEMBER_KICKED`, `PLAYER_GROUP_DISBANDED`. Convite repetido não audita.

**Ownership revogada:** leituras e ações exigem ownership atual VERIFIED; o dono
revogado perde acesso e deixa de receber eventos. A membership não é transferida
nem removida automaticamente (continua ocupando a vaga); limpeza automática ao
revogar ownership fica como evolução futura.

### Guilds / Clans

- Domínio persistente próprio.
- **Guild/clan não é Skyrim Faction.** Os contratos `CHARACTER_FACTION_*`
  administrativos não são reutilizados como guilda.
- Membros, cargos e convites.
- Integração com o jogo pode existir depois, sem mudar o modelo do backend.

#### Implementação (10.9)

Módulo `src/player-guilds/`. **GUILD** é o nome canônico no backend ("Clan" pode
ser só nomenclatura de UI). Guild é **backend-owned**: não há GameCommand, evento
de Agent, Papyrus, Faction nem sincronização com o Skyrim; uma representação no
jogo fica para integração futura.

**A guild pertence ao character identity** (`game_server_id` +
`character_external_id`), não ao vínculo de ownership. A ownership VERIFIED serve
apenas para autorizar o Player atual a agir pelo character. Se o character mudar
de dono, membership e cargo permanecem com o character — diferente de Groups, que
pertencem ao ownership atual.

| Tabela | Colunas e garantias |
| --- | --- |
| `player_guilds` | `id`, `game_server_id` (FK), `name` (exibição), `name_key` (normalizado), `status` ACTIVE/DISBANDED, `created_at`, `updated_at`, `disbanded_at` (presente sse DISBANDED); `UNIQUE(id, game_server_id)` para as FKs compostas; índice único parcial `(game_server_id, name_key) WHERE status = 'ACTIVE'` |
| `player_guild_members` | `id`, `guild_id` + `game_server_id` (**FK composta** para `player_guilds(id, game_server_id)`: o membro sempre é do servidor da guild), `character_external_id`, `role` MASTER/OFFICER/MEMBER, `joined_at`, `left_at`; índice único parcial de **uma membership ativa por character identity** e de **um MASTER ativo por guild**; histórico nunca apagado |
| `player_guild_invites` | `id`, `guild_id` + `game_server_id` (FK composta), `target_character_external_id`, `invited_by_character_external_id`, `status` PENDING/ACCEPTED/DECLINED/CANCELLED/EXPIRED, `expires_at`, `responded_at` (nulo sse PENDING), `created_at`; índice único parcial de um PENDING por guild + target |

Nenhuma tabela de guild referencia `player_characters` nem `players`.

**Nome:** trim; 3..48 code points; rejeita controles, caracteres de formato
(zero-width, overrides bidi), separadores de linha/parágrafo, private-use, não
atribuídos e surrogates isolados. O nome original (após trim) é preservado para
exibição. A unicidade usa `name_key` = NFKC → maiúsculas → minúsculas
(aproxima case folding completo: "ß" ≡ "SS") → NFKC → sequências de espaço viram
um espaço. A chave é independente de locale, calculada uma vez e armazenada;
nomes em formas de compatibilidade (ex.: letras full-width) colidem. Único por
GameServer entre guildas ACTIVE; o mesmo nome é permitido em outro servidor e
volta a ficar livre após DISBANDED.

**Roles** (policy centralizada em `GUILD_PERMISSIONS`):

| Role | Pode |
| --- | --- |
| MASTER | invite; kick OFFICER/MEMBER; promote MEMBER → OFFICER; demote OFFICER → MEMBER; transfer master; disband |
| OFFICER | invite |
| MEMBER | leitura; leave |

O MASTER não usa `leave`: precisa transferir a maestria ou desfazer a guild (409).
Transfer master é atômico: MASTER atual → OFFICER e depois target → MASTER, na
mesma transação, sob o lock da guild; o índice parcial garante no máximo um
MASTER, e o fluxo garante exatamente um em toda guild ACTIVE.

- Máximo **provisório de 50 membros ativos** em `MAX_GUILD_MEMBERS`, sem relação
  com VIP; verificado sob o lock da guild (alterar não exige migration).
- Convites valem `PLAYER_GUILD_INVITE_TTL` (padrão 7d, de 1h a 30d). Expiração
  lazy como em Groups: a listagem omite expirados e usar ou repetir um convite
  expirado o materializa como EXPIRED. Sem scheduler.

**Lifecycle:** create (ACTIVE + MASTER) → invites → accept/decline → role
changes / transfer master → leave/kick → disband. Accept cria o MEMBER, marca o
convite ACCEPTED e **cancela os demais convites PENDING do mesmo character**.
Disband marca DISBANDED, fecha todas as memberships (`left_at`) e cancela convites
PENDING; a guild fica como histórico.

**Player API** (`PlayerAuthGuard` em tudo; o player vem do token; o vínculo do
ator precisa ser próprio e VERIFIED, senão 404 `Character not found`; não membro
→ 404 `Guild not found`; membro sem permissão → 403):

| Rota | Regra |
| --- | --- |
| `POST /api/v1/player/guilds` `{ characterLinkId, name }` | 201; character sem guild ativa, servidor habilitado, nome disponível (409 `Guild name unavailable`) |
| `GET /api/v1/player/me/characters/:characterLinkId/guild` | `{ guild }` do character, ou `{ guild: null }` |
| `GET /api/v1/player/guilds/:guildId?characterLinkId=` | só se o character indicado for membro ativo |
| `POST .../:guildId/invites` `{ actorCharacterLinkId, targetCharacterId }` | MASTER/OFFICER; target resolvido no servidor da guild; não resolvido → 404 `Character not available`; já na guild → 409 `Character already in this guild`; em outra guild → 409 `Character unavailable`; cheia → 409 `Guild full`. Convite PENDING repetido → 200 com o mesmo convite, sem Audit |
| `GET /api/v1/player/guild-invites?characterLinkId=` | PENDING, não expirados, destinados ao character indicado |
| `POST /api/v1/player/guild-invites/:inviteId/accept` `{ characterLinkId }` | só pelo vínculo VERIFIED do target; PENDING, não expirado, guild ACTIVE, vaga livre, character sem guild ativa |
| `POST .../:inviteId/decline` `{ characterLinkId }` | mesmo padrão |
| `POST .../:guildId/leave` `{ characterLinkId }` | MEMBER/OFFICER; MASTER → 409 |
| `POST .../:guildId/members/:memberId/kick` `{ actorCharacterLinkId }` | MASTER; a si mesmo → 400 |
| `POST .../:guildId/members/:memberId/role` `{ actorCharacterLinkId, role }` | MASTER; `role` OFFICER ou MEMBER (MASTER → 400); target MASTER → 400; mesmo cargo → 200 sem Audit |
| `POST .../:guildId/members/:memberId/transfer-master` `{ actorCharacterLinkId }` | MASTER; a si mesmo → 400 |
| `POST .../:guildId/disband` `{ actorCharacterLinkId }` | MASTER |

`targetCharacterLinkId`, `targetPlayerId`, `gameServerId` e campos extras → 400.
`targetCharacterId` segue a validação padrão de `characterExternalId`.

**Ownership:** a Player API sempre autoriza pelo `characterLinkId` próprio
VERIFIED, mas a membership é do character. Se a ownership for REVOKED, o antigo
dono perde acesso imediatamente e deixa de receber realtime; a membership **não**
é removida. Se outro Player verificar o mesmo character, passa a ver a mesma
membership e cargo (inclusive MASTER) e a agir com eles.

**DTO/privacy:** a guild é `{ id, gameServer: { id, code, name, enabled }, name,
status, members: [{ memberId, characterId, characterLinkId, role, joinedAt }],
createdAt }`; `characterId` é o `characterExternalId` e `characterLinkId` só é
preenchido para characters do player autenticado (null para os demais). O convite
é `{ inviteId, guildId, guildName, gameServerId, targetCharacterId,
invitedByCharacterId, status, expiresAt, createdAt, respondedAt }`. Nunca aparecem
`playerId`, vínculos de outros players nem identidade de provider.

**Concorrência:** ordem de locks guild → vínculos (ator, depois target) →
memberships/convites; criação (sem guild ainda) começa no vínculo do character.
Accept trava guild, vínculo do target e só então o convite, o que evita deadlock
ao cancelar convites de outras guildas. Tudo que muda uma guild trava a sua linha,
serializando role × kick, transfer × disband e transfers simultâneos. Os índices
parciais são a garantia final (violações viram 409): criações simultâneas do mesmo
character geram uma guild; o mesmo nome no mesmo servidor tem um vencedor; dois
accepts de guildas diferentes geram uma membership; a última vaga admite um; nunca
há dois MASTER. Sem mutex em memória.

**Audit** (actor PLAYER, `resourceType = PLAYER_GUILD`, metadata com `guildId`,
`gameServerId`, `actorCharacterId` e, quando relevante, `targetCharacterId`,
`memberId`, `role`/`previousRole`, `inviteId`): `PLAYER_GUILD_CREATED`,
`PLAYER_GUILD_INVITED`, `PLAYER_GUILD_INVITE_ACCEPTED`,
`PLAYER_GUILD_INVITE_DECLINED`, `PLAYER_GUILD_MEMBER_LEFT`,
`PLAYER_GUILD_MEMBER_KICKED`, `PLAYER_GUILD_MEMBER_ROLE_CHANGED`,
`PLAYER_GUILD_MASTER_TRANSFERRED`, `PLAYER_GUILD_DISBANDED`, na mesma transação da
mutação. Convite repetido e mudança para o mesmo cargo não auditam. Convites
cancelados como efeito indireto não têm Audit próprio: o accept e o disband
registram `cancelledInvites`.

**Realtime:** reutiliza o `RealtimeEventBus` e o gateway da 10.8 (nenhum segundo
gateway). Onze eventos: `GUILD_CREATED`, `GUILD_INVITE_CREATED`,
`GUILD_INVITE_ACCEPTED`, `GUILD_INVITE_DECLINED`, `GUILD_INVITE_CANCELLED`,
`GUILD_MEMBER_JOINED`, `GUILD_MEMBER_LEFT`, `GUILD_MEMBER_KICKED`,
`GUILD_MEMBER_ROLE_CHANGED`, `GUILD_MASTER_TRANSFERRED`, `GUILD_DISBANDED`,
publicados após o commit aos donos VERIFIED atuais dos membros envolvidos, ao
target do convite e aos membros restantes; nunca a estranhos nem a Staff. Payloads
trazem ids de guild/membro/convite e `characterExternalId`, nunca `playerId` ou
vínculos. Realtime continua não sendo fonte de verdade.

`GUILD_INVITE_CANCELLED` cobre o cancelamento indireto de um convite PENDING:
payload `{ guildId, gameServerId, inviteId, targetCharacterId, reason }`, com
`reason` fechado em `TARGET_JOINED_ANOTHER_GUILD` (o target aceitou outra guild) ou
`GUILD_DISBANDED`. O cancelamento é um único `UPDATE ... WHERE status = 'PENDING'
RETURNING`, e só as linhas que realmente passaram de PENDING para CANCELLED geram
evento (um por convite; convites já respondidos não geram nada). Vai ao dono
VERIFIED atual do target e aos membros da guild que emitiu o convite (no disband,
aos membros que a guild tinha). Rollback não publica.

### Economy / Wallet

- **O ledger do backend é a fonte de verdade econômica.**
- **Gold do Skyrim não é usado como banco transacional.**
- **Wallet é derivada de ledger imutável** (lançamentos append-only; saldo nunca é
  campo editável isolado).
- O Agent pode refletir efeitos no jogo, sem ser a autoridade do saldo.
- **Nenhuma mutation do Electron altera saldo diretamente.** Toda variação de saldo
  é consequência de uma operação de domínio (trade, marketplace, SYSTEM) que gera
  lançamentos.

#### Implementação (10.12)

Módulo `src/economy/`. O **ledger do backend é a fonte de verdade**; o gold do
inventário do Skyrim não é lido nem sincronizado, e não há GameCommand, evento de
Agent ou realtime nesta etapa (HTTP basta; `WALLET_BALANCE_CHANGED` pode vir com
Trade/Marketplace se houver consumidor).

**Moeda:** `GOLD` fechada, em **unidades inteiras** (sem float nem decimais). O
schema já tem `currency` explícita em accounts, transactions e entries; outra
moeda exige migration (CHECK).

**A wallet pertence ao character identity** (`game_server_id` +
`character_external_id`), não ao vínculo `player_characters`. A ownership VERIFIED
só autoriza o Player atual a ler; se o dono mudar, saldo e histórico ficam com o
character (sem segunda account).

| Tabela | Colunas e garantias |
| --- | --- |
| `economy_accounts` | `id`, `game_server_id` (FK), `currency`, `owner_type` CHARACTER/SYSTEM, `character_external_id` (só CHARACTER), `system_key` MINT/BURN (só SYSTEM), `balance` bigint, `created_at`, `updated_at`; CHECK do shape do owner; índices únicos parciais por `(server, currency, character)` e `(server, currency, system_key)`; CHARACTER 0..1.000.000.000.000, SYSTEM ±9·10¹⁵ |
| `economy_transactions` | `id`, `game_server_id`, `currency`, `type` SYSTEM_CREDIT/SYSTEM_DEBIT/TRANSFER, ator do Generic Actor (`actor_type`, `actor_player_id`, `actor_staff_id`, `actor_system_source`) com o mesmo CHECK de scope de `game_commands`, `idempotency_scope`, `idempotency_key`, `request_fingerprint` (sha256 do conteúdo), `reference_type`/`reference_id` (ambos ou nenhum), `created_at`; `UNIQUE(game_server_id, idempotency_scope, idempotency_key)`; SYSTEM_* só com ator SYSTEM |
| `economy_entries` | `id`, `transaction_id`, `account_id`, `game_server_id`, `currency`, `amount` bigint com sinal (≠ 0), `created_at`; FKs compostas `(id, server, currency)` para a transaction e para a account (a entry nunca cruza servidor/moeda); uma entry por account por transaction |

**Partidas dobradas, garantidas no PostgreSQL:**

- constraint triggers `DEFERRABLE INITIALLY DEFERRED` em transactions e entries
  recusam o COMMIT de uma transaction sem pelo menos duas entries ou com soma ≠ 0;
- transactions e entries são **append-only** (UPDATE/DELETE/TRUNCATE → erro, como
  `audit_logs`); FKs sem cascade impedem apagar o ledger indiretamente;
- `balance` é uma **projeção**: um trigger de entry soma `amount` à account na
  mesma transação; UPDATE direto de balance, mudança de identidade da account,
  INSERT com saldo ≠ 0 e DELETE/TRUNCATE de accounts são recusados; o CHECK impede
  saldo de character negativo mesmo numa posting balanceada;
- `down` da migration recusa reverter com ledger não vazio.

Exemplos: credit 500 = `MINT −500 / CHARACTER +500`; debit 200 =
`CHARACTER −200 / BURN +200`; transfer 100 = `A −100 / B +100`.

**Núcleo `EconomyLedgerService.post()`** (interno, reutilizável por 10.13/10.14;
não autoriza Player): valida a posting (≥ 2 legs, soma zero, inteiros seguros,
accounts distintas, moeda, tipo, ator e key), cria accounts preguiçosamente
(`INSERT … ON CONFLICT DO NOTHING`), trava todas **em ordem crescente de id**
(`FOR UPDATE`), confere a idempotência de novo sob os locks, roda o `authorize`
do domínio, valida fundos e limites, insere transaction e entries e roda o hook
`posted` (Audit) — tudo numa transação. Rejeições (`INSUFFICIENT_FUNDS`,
`BALANCE_LIMIT`, `SYSTEM_LIMIT`, `IDEMPOTENCY_CONFLICT`, `PLAYER_UNAVAILABLE`,
`INVALID_INPUT`) fazem rollback completo, inclusive das accounts recém-criadas.

**Idempotência:** scopes do Generic Actor (`STAFF`, `PLAYER:<id>`,
`SYSTEM:<source>`), nunca expostos. Mesmo scope + key + conteúdo → a mesma
transaction (`ALREADY_POSTED`, sem lançamento nem Audit extra); mesma key com
conteúdo diferente → `IDEMPOTENCY_CONFLICT`. O `UNIQUE` é a autoridade final.

**Movimentos internos** (`EconomyService`, sem rota HTTP):

- `creditFromSystem` (MINT → character) e `debitFromSystem` (character → BURN), ator
  SYSTEM com source da allowlist existente; debit sem saldo é rejeitado sem
  alterar nada. Mesma regra de status de Professions: se o character tem dono
  VERIFIED SUSPENDED/BANNED → `PLAYER_UNAVAILABLE`; sem dono VERIFIED o movimento
  ocorre (a wallet é do character). Auditados como `ECONOMY_SYSTEM_CREDITED` /
  `ECONOMY_SYSTEM_DEBITED` (ator SYSTEM, `resourceType = ECONOMY_TRANSACTION`,
  metadata `gameServerId`, `characterExternalId`, `currency`, `amount`,
  `transactionId`; sem key, ids de account ou saldos), na mesma transação.
- `transfer` (character → character, `from ≠ to`, amount > 0, qualquer ator) é
  infraestrutura para Trade e **não gera Audit genérico**: o domínio chamador
  (10.13) audita sua ação de negócio.

**Concorrência:** locks ordenados serializam postings sobre as mesmas accounts sem
deadlock (inclusive transfers em sentidos opostos); retries simultâneos convergem
numa transaction; débitos concorrentes nunca deixam saldo negativo. Sem mutex em
memória. As accounts MINT/BURN de cada servidor são um ponto de serialização para
credits/debits.

**Reconciliação:** `EconomyReconciliationService` (interno, sem endpoint) lista
accounts com `balance ≠ SUM(entries)` e transactions desbalanceadas.

**Player API (somente leitura):**

| Rota | Retorno |
| --- | --- |
| `GET /api/v1/player/me/characters/:characterLinkId/wallet` | `{ characterLinkId, currency: "GOLD", balance }`; 0 sem ledger, sem criar account |
| `GET /api/v1/player/me/characters/:characterLinkId/wallet/transactions?page&limit` | página (padrão existente) de `{ transactionId, type, amount, direction: CREDIT/DEBIT, referenceType, referenceId, createdAt }`, mais recentes primeiro |

Vínculo próprio e VERIFIED (senão 404); o histórico só mostra a perna do
character (magnitude + direção), sem accounts, contrapartes, system accounts,
atribuição ou idempotência. Não existe rota que credite, debite ou transfira.

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

#### Implementação (10.8)

**Domain events:** `RealtimeEventBus` (`src/realtime-events/`, global, sem
dependência de WebSocket). Domínios chamam `publish(type, data, { playerIds })`
**depois do commit**; o bus gera o envelope `{ eventId, type, occurredAt, data }`,
aceita em `data` apenas valores primitivos (nenhuma entidade TypeORM) e deduplica
destinatários. Tipos iniciais: `GROUP_CREATED`, `GROUP_INVITE_CREATED`,
`GROUP_INVITE_ACCEPTED`, `GROUP_INVITE_DECLINED`, `GROUP_MEMBER_JOINED`,
`GROUP_MEMBER_LEFT`, `GROUP_MEMBER_KICKED`, `GROUP_DISBANDED`.

**Transporte:** `src/realtime/`, com a biblioteca `ws` acoplada ao servidor HTTP do
Nest (sem Socket.IO) em `ws(s)://<host>/api/v1/realtime`. Caminho diferente ou
qualquer query string é rejeitado no handshake (400): tokens nunca vão na URL.

**Handshake:**

1. o socket conecta e fica AUTHENTICATING;
2. o primeiro frame deve ser exatamente
   `{ "type": "AUTH", "surface": "PLAYER" | "STAFF", "token": "<access token>" }`
   dentro de `REALTIME_AUTH_TIMEOUT_MS` (padrão 5000);
3. PLAYER é verificado pelo `PlayerAuthService` e STAFF pelo `AuthService`, cada um
   com seus secrets/issuer/audience, sessão e status; refresh tokens e tokens da
   outra superfície falham;
4. sucesso → `{ "type": "AUTHENTICATED", "surface", "expiresAt" }` e registro da
   conexão por identidade (`PLAYER:<id>` ou `STAFF:<id>`).

Códigos de fechamento: 4000 `AUTH_TIMEOUT`, 4001 `UNAUTHORIZED`, 4002
`TOKEN_EXPIRED`, 4003 `PROTOCOL_ERROR` (frame inválido, campos extras, frame
binário ou qualquer mensagem após autenticar), 1001 no desligamento. Frames até
16 KiB.

**Expiração:** o socket é fechado (4002) quando o `exp` do access JWT chega; o
cliente reconecta com um novo access token. Não há refresh via WebSocket. Logout
ou suspensão durante a conexão só têm efeito na expiração ou reconexão (o HTTP
continua bloqueando imediatamente).

**Fan-out:** o servidor escolhe os destinatários; o cliente não entra em rooms nem
informa player/group. Eventos de Group vão aos donos atuais (VERIFIED) dos membros
ativos e ao dono do target do convite, em todas as conexões do player. Conexões
STAFF são autenticadas mas ainda não recebem eventos. O fechamento remove a
conexão do registry.

**Limitação:** entrega em memória, best-effort e de processo único: sem Redis,
broker ou outbox. Um evento pode se perder (queda, reconexão); o cliente refaz o
GET HTTP. Entrega entre múltiplas instâncias e garantias de entrega ficam para a
Etapa 12.

A 10.9 adiciona os eventos `GUILD_*` ao mesmo bus e gateway; fan-out e regras de
privacidade seguem o mesmo modelo (donos VERIFIED atuais, sem Staff).

### Properties / Houses / Holds e Horses / Mounts

- **Reutilizar contratos Character existentes para leitura**
  (`CHARACTER_PROPERTIES_QUERY`, `CHARACTER_HOLDS_QUERY`, `CHARACTER_HORSES_QUERY`).
- A **Player API usa ownership VERIFIED em vez de Staff permission**.
- Mutations administrativas (grant/revoke/give) continuam exclusivas da Admin API.

#### Implementação (10.10)

Properties e Holds para o Player são **leitura do Skyrim** pelos contratos da
Etapa 05, reutilizados sem alteração: `CHARACTER_PROPERTIES_QUERY` e
`CHARACTER_HOLDS_QUERY`, com o mesmo payload `{ characterId }`, os mesmos
validators de resultado (`{ characterId, properties: [{ propertyId,
displayName? }] }` e `{ characterId, holds: [{ holdId, displayName? }] }`, até 512
entradas, rejeição de mismatch de `characterId`), limites de payload/resultado e
lifecycle de GameCommand. Nenhum tipo novo, tabela, snapshot ou read-model.

- **Properties = casas/propriedades apresentadas ao Player.** "House" é só a
  apresentação player-facing de Properties; não existe tabela `houses` nem um
  segundo conceito técnico.
- **Holds** são as Holds do Skyrim associadas ao character, somente leitura. Não
  são Guilds (10.9), reinos nem Factions.
- **Sem compra, venda, grant ou revoke pelo Player.** A aquisição comercial de
  propriedades dependerá de Economy (10.12) e será decidida depois.

**Player API** (mesmo módulo e padrão da 10.5, `PlayerAuthGuard`,
`Idempotency-Key` obrigatório, body vazio, campos extras → 400):

| Rota | CommandType |
| --- | --- |
| `POST /api/v1/player/game-servers/:gameServerId/characters/:characterId/properties-query` | `CHARACTER_PROPERTIES_QUERY` |
| `POST /api/v1/player/game-servers/:gameServerId/characters/:characterId/holds-query` | `CHARACTER_HOLDS_QUERY` |

Ambas respondem 202 + `Location` e são lidas em
`GET /api/v1/player/character-operations/:operationId`, cuja allowlist
(`PLAYER_CHARACTER_QUERY_TYPES`) passa a incluir os dois tipos; o resultado é
revalidado antes de apresentado e o detalhe continua sem payload, atribuição,
scope, key, correlation, lease ou tentativas. Ownership, ator PLAYER, scope
`PLAYER:<playerId>` e códigos (404 genérico, 409 servidor desabilitado ou key
reutilizada com outro conteúdo) são os da 10.5. Queries não geram Audit; o
GameCommand é a trilha operacional. Nenhum evento realtime novo.

**Separação Player/Admin:** a allowlist Player contém apenas queries; as rotas
Staff de grant/revoke (`CHARACTER_PROPERTY_*`, `CHARACTER_HOLD_*`) continuam com as
mesmas permissions e recusam tokens Player (401). Commands Staff desses tipos não
aparecem no detalhe Player (404). O detalhe administrativo de domínio
(`GET /api/v1/character-operations/:commandId`, e os de World/Moderation) passa a
considerar apenas commands de autoria STAFF: uma query criada por Player não é
uma operação Staff de Character Management (404 ali) e continua visível somente na
view genérica e redigida `GET /api/v1/game-commands/:id`, sem payload nem
resultado.

#### Implementação (10.11)

Horses/Mounts para o Player são **leitura do estado do Skyrim** pelo contrato da
Etapa 05 `CHARACTER_HORSES_QUERY`, reutilizado sem alteração: payload
`{ characterId }`, resultado `{ characterId, horses: [{ horseId, displayName? }] }`
(até 512 entradas, `horseId` opaco, rejeição de mismatch de `characterId`), limites
e lifecycle de GameCommand. "Mount" é só nomenclatura de UI: o backend continua no
domínio Horses, sem segunda entidade técnica, tabela de mounts, snapshot ou
read-model.

- Rota: `POST /api/v1/player/game-servers/:gameServerId/characters/:characterId/horses-query`
  (mesmo padrão da 10.5/10.10: `PlayerAuthGuard`, `Idempotency-Key`, body vazio,
  202 + `Location`, ownership VERIFIED dentro da transação, ator PLAYER, scope
  `PLAYER:<playerId>`, sem Audit, sem realtime).
- `PLAYER_CHARACTER_QUERY_TYPES` passa a ter **5 tipos**: profile, skills,
  properties, holds e horses. O detalhe
  `GET /api/v1/player/character-operations/:operationId` apresenta
  `CHARACTER_HORSES_QUERY` revalidado, só ao autor.
- **Sem `CHARACTER_HORSE_GIVE`/`CHARACTER_HORSE_REVOKE` para o Player**: continuam
  exclusivos da Admin API, com as mesmas permissions e o Audit existente. Compra de
  cavalo depende de Economy (10.12); summon/call horse não existe no contrato atual
  e não foi definido.
- A decisão da 10.10 vale aqui: uma horses query criada por Player não aparece no
  detalhe administrativo de Character Management, só na view genérica redigida.

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
| Regras de troca de profissão e origem dos eventos de XP no jogo | pós-definição de produto / Etapa 11 |
| Tamanho definitivo de group (hoje 5, provisório) e limpeza de memberships de ownership revogada | pós-definição de produto |
| Limite definitivo de guild (hoje 50, provisório), relação com VIP e representação no jogo | pós-definição de produto / Etapa 11 |
| Taxas de marketplace | 10.14 |
| Retenção de chat | 10.15 |
| Moedas além de GOLD e contas de escrow | 10.13 / 10.14 |

Pontos de implementação a fixar no início da subetapa correspondente, sem alterar
as decisões acima:

| Tema | Subetapa |
| --- | --- |
| Efeito de SUSPENDED/BANNED em trade e marketplace; revogação administrativa de vínculos | 10.13 / 10.14 / futura |
| Transporte autenticado do Agent chamando `confirmFromAgent` e digitação do challenge no jogo | 11 |
| Implementação real de perfil e skills pelo Agent, conforme os contratos da 10.5 | 11 |
| Chaves de Player Settings | 10.16 |
| Rate limiting distribuído, confiança em proxy e cotas por conta | Etapa 12 |
