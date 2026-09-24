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
| 10.2 Generic Actor + Player-safe Idempotency | Ator STAFF/PLAYER/SYSTEM em Audit e GameCommand; idempotência por ator; núcleo de operações desacoplado de `AuthenticatedStaff` |
| 10.3 Player Authentication | Discord OAuth2, sessões, tokens, guard, `GET /api/v1/player/me` |
| 10.4 Character Ownership | Vínculo PENDING/VERIFIED/REVOKED e contrato de confirmação pelo Agent |
| 10.5 Character Profile + Skills | Contratos de GameCommand para perfil e skills; leitura pela Player API |
| 10.6 Multiple Characters | Listagem e gestão dos vínculos 1:N do player |
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
| Escopos do Discord OAuth2 e fluxo no Electron (ex.: authorization code com PKCE) | 10.3 |
| Criação de conta no primeiro login ou cadastro explícito; TTL/revogação de sessão | 10.3 |
| Efeito de SUSPENDED/BANNED em sessões, ownership, trade e marketplace | 10.3 |
| Forma da idempotência por ator (constraint vs tabela) e representação do ator | 10.2 |
| Mecanismo de confirmação de ownership com o Agent | 10.4 (contrato) / 11 (real) |
| Campos de perfil e skills expostos pelo Agent | 10.5 |
| Chaves de Player Settings | 10.16 |
| Rate limiting e cotas da Player API | 10.3 |
