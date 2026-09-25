# Electron / Launcher integration contract — 11.5, fechado na 11.6

Electron/Launcher source code não está neste repo; 11.5 define o contrato e fecha
os gaps do Backend, e a 11.6 fecha o último gap de cold-start (Groups). Não há UI
ou implementação de IPC neste repositório.

**Permanece externo a este repositório:** o comportamento real de OAuth/PKCE do
provider (Discord) no cliente, a implementação do Electron, o C# Launcher e o
IPC concreto entre eles. Este documento descreve apenas o contrato que o Backend
cumpre e os requisitos que o código externo precisa validar.

## Inventário final de Player APIs

Rotas relativas a `/api/v1`; `P = /player`, `C = /player/me/characters/:characterLinkId`,
`Q = /player/game-servers/:gameServerId/characters/:characterId`.
`O = GET /player/character-operations/:operationId`. `characterLinkId` é o UUID do
vínculo; `characterId`/`characterExternalId` é a identidade opaca no servidor.
Não são intercambiáveis. Todas as linhas usam HTTP/database como estado canônico
consumido pelo painel; resultados de gameplay são snapshots obtidos do Skyrim.
Nenhuma Player API desta matriz depende de IPC do Launcher local.

| Feature | HTTP read | HTTP mutation/request | Realtime wake-up | Fonte de verdade | Agent remoto? | Polling/reconciliation | Launcher IPC? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Auth/account | GET P/me | POST P/auth/discord/exchange, /refresh, /logout | nenhum | sessão/conta backend | não | revalidar sessão e GET me | não |
| Server discovery | GET P/game-servers | nenhuma Player | nenhum | game_servers + sessão/runtime persistidos | só informa presença | GET periódico/refresh após 11.5 | não |
| Characters/ownership | GET P/me/characters, GET C, GET P/character-links/:linkId | POST P/character-links; POST P/character-links/:linkId/revoke | PLAYER_CHARACTER_LINK_UPDATED | links backend; prova do Agent | para verificar | GET link/diretório | não |
| Profile | O | POST Q/profile-query, body `{}` | PLAYER_GAME_OPERATION_UPDATED | snapshot Skyrim persistido no result | sim | GET operação até terminal | não |
| Skills | O | POST Q/skills-query, body `{}` | PLAYER_GAME_OPERATION_UPDATED | snapshot Skyrim persistido no result | sim | GET operação até terminal | não |
| Professions | GET C/profession | POST C/profession | nenhum | profissão/XP backend | apenas XP | GET ao abrir/refresh/periódico para XP | não |
| Groups | GET C/group (11.6); GET P/groups/:groupId; GET P/group-invites | POST P/groups; POST P/groups/:groupId/{invites,leave,disband}; POST P/groups/:groupId/members/:memberId/kick; POST P/group-invites/:inviteId/{accept,decline} | GROUP_* | backend | não | GET C/group por character + invites | não |
| Guilds | GET C/guild; GET P/guilds/:guildId?characterLinkId=…; GET P/guild-invites?characterLinkId=… | POST P/guilds; POST P/guilds/:guildId/{invites,leave,disband}; POST P/guilds/:guildId/members/:memberId/{kick,role,transfer-master}; POST P/guild-invites/:inviteId/{accept,decline} | GUILD_* | backend | não | refetch guild/membership/invites | não |
| Properties/houses | O | POST Q/properties-query, body `{}` | PLAYER_GAME_OPERATION_UPDATED | snapshot Skyrim persistido no result | sim | GET operação | não |
| Holds | O | POST Q/holds-query, body `{}` | PLAYER_GAME_OPERATION_UPDATED | snapshot Skyrim persistido no result | sim | GET operação | não |
| Horses/mounts | O | POST Q/horses-query, body `{}` | PLAYER_GAME_OPERATION_UPDATED | snapshot Skyrim persistido no result | sim | GET operação | não |
| Wallet | GET C/wallet; GET C/wallet/transactions | nenhuma Player | sem evento próprio; TRADE_*/MARKETPLACE_* invalidam saldo | ledger backend | não | refetch após domínio; refresh para mudanças externas | não |
| Trade | GET C/trades; GET P/trades/:tradeId?characterLinkId=… | POST P/trades; PUT P/trades/:tradeId/offer; POST P/trades/:tradeId/{accept,cancel} | TRADE_* | ofertas/escrow/ledger backend | GAME_ITEM; GOLD-only resolve no backend | refetch trade, lista e wallet | não |
| Marketplace | GET P/marketplace/listings; GET P/marketplace/listings/:listingId; GET C/marketplace/{listings,purchases} | POST P/marketplace/listings; POST P/marketplace/listings/:listingId/{purchase,cancel} | MARKETPLACE_* | listing/purchase/escrow backend | custody/settlement/release | refetch listas próprias, compra e wallet; browse periódico | não |
| Chat | GET C/chat/global; GET C/chat/direct/:targetCharacterId; GET P/{groups/:groupId,guilds/:guildId}/chat?characterLinkId=… | POST P/chat/global; POST P/chat/direct/:targetCharacterId; POST P/{groups/:groupId,guilds/:guildId}/chat | CHAT_MESSAGE_CREATED | histórico backend | não | refetch histórico e dedup por messageId | não |
| Settings | GET P/settings | PATCH P/settings | PLAYER_SETTINGS_UPDATED | preferências de conta backend | não | refetch settings | não |
| VIP | GET /vip-store/offers e /:code (públicos); GET P/vip/entitlements; GET C/vip/{entitlements,effective} | nenhuma Player: não existe compra/pagamento/grant/revoke HTTP Player | VIP_ENTITLEMENT_GRANTED/REVOKED | catálogo e direitos backend | entrega CHARACTER; leitura não | refetch direitos; expiração por relógio também exige GET | não |

A matriz foi levantada antes das alterações de código e consolidada com os três
gaps fechados na 11.5: discovery e os eventos de link/operação. Não foram criadas
rotas alternativas para features existentes.

## Contrato HTTP final do painel

O inventário foi verificado nos controllers, DTOs e serviços. As mudanças da
11.5 são:

| Feature | HTTP read final | HTTP mutation | Realtime final | Reconciliação | Agent remoto | Launcher IPC |
| --- | --- | --- | --- | --- | --- | --- |
| GameServers | GET `/api/v1/player/game-servers?page=1&limit=20` | nenhuma | nenhum | HTTP periódico/manual e após reconnect | fornece runtime, não necessário para listar | não |
| Characters/ownership | mesmas rotas do inventário | mesmas rotas | `PLAYER_CHARACTER_LINK_UPDATED` | GET link/diretório; polling enquanto PENDING se faltar evento | verifica prova | não |
| Profile, Skills, Properties, Holds, Horses | GET operação existente | POST query existente | `PLAYER_GAME_OPERATION_UPDATED` | GET operação; polling limitado até terminal | executa query | não |

Todas as demais linhas mantêm as rotas e eventos do inventário, com **Launcher
IPC = não**. O estado local do Skyrim é uma feature separada, descrita adiante.
Não há autorização implícita por conhecer um characterId ou gameServerId.

### Convenções de consumo

- Prefixo HTTP `/api/v1`. Use `Authorization: Bearer <Player accessToken>`,
  nunca Staff token. Catálogo `/vip-store/offers` é público; exchange/refresh
  recebem seus próprios bodies de autenticação.
- Schemas completos de request/response e códigos HTTP estão no OpenAPI servido
  em `/docs` (`/docs-json`). Este contrato descreve o fluxo sem exigir leitura de
  classes internas. [Player Services](player-services.md) detalha as regras de
  negócio, paginação e limites de cada feature.
- Paginação de discovery, diretório, Trade, Marketplace e wallet transactions:
  `page`/`limit`, resposta `{ items, total, page, limit, totalPages }`. Discovery
  usa defaults 1/20, limit 1–100 e ordenação name/id. Invites e entitlements têm
  suas listas próprias; não presumir paginação universal. Chat usa paginação
  própria (histórico mais recente primeiro).
- POST de queries de gameplay aceita body `{}`, exige `Idempotency-Key` e retorna
  `202` com `operationId`, `type`, `gameServerId`, `characterId`, `status`,
  `createdAt` e header `Location` da leitura canônica. `202` não é execução bem
  sucedida. GET da operação não cria uma nova query. Para um snapshot novo,
  solicite outra operação com nova key; para retry da mesma solicitação, reuse
  a key. Guarde os operationIds enquanto forem relevantes: não há listagem
  Player de todas as operações.
- Trade, Marketplace e envio de Chat também exigem `Idempotency-Key`. Reuse a
  key somente para repetir a mesma intenção/conteúdo. Não envie keys aos Agents.
  Outras mutations seguem a idempotência específica descrita no OpenAPI.
- `400`: entrada inválida/campo não permitido; `401`: reautenticar; `403`: conta
  indisponível; `404`: recurso inexistente ou não acessível; `409`: conflito de
  estado/ownership/versão/idempotência; `429`: reduzir ritmo; `503`: dependência
  temporariamente indisponível. Leia o erro do endpoint e reconcilie antes de
  repetir mutations. Não tratar erro de transporte como prova de rollback.
- Identificadores de jogo são opacos: aplicar URL encoding em segmentos de rota,
  não inferir playerId, ownership ou paths locais a partir deles.

### Inputs por feature

| Feature/action | Body ou parâmetro necessário | Leitura após resposta/evento |
| --- | --- | --- |
| Solicitar link | `{ gameServerId, characterExternalId }`; resposta inclui `linkId`, challenge de uso único e `challengeExpiresAt` | GET `/player/character-links/:linkId` |
| Revogar link | POST `/player/character-links/:linkId/revoke`, `{}` | GET link; reler diretório |
| Profile/Skills/Properties/Holds/Horses | servidor + characterId na rota Q, `{}`, `Idempotency-Key` | O; result.data validado para o tipo de query |
| Profissão | POST C/profession `{ profession }` conforme catálogo do OpenAPI; seleção única, repetir a mesma é idempotente | GET C/profession (XP não tem evento próprio) |
| Criar Group / sair | `{ characterLinkId }` | GET `/player/groups/:groupId` conhecido; saída pode tornar o GET 404 |
| Convidar Group | `{ actorCharacterLinkId, targetCharacterId }` | grupo e `/player/group-invites` |
| Group kick/disband e aceitar/recusar invite | `{}` nas rotas do inventário | grupo e invites |
| Criar Guild | `{ characterLinkId, name }` | GET C/guild e guild detail |
| Guild invite | `{ actorCharacterLinkId, targetCharacterId }` | guild e invites do character |
| Guild leave, invite accept/decline | `{ characterLinkId }` | GET C/guild e invites |
| Guild kick/disband/transfer-master | `{ actorCharacterLinkId }` | GET guild com `characterLinkId` na query |
| Guild role | `{ actorCharacterLinkId, role: "OFFICER" ou "MEMBER" }` | GET guild |
| Wallet | somente GET, sem body ou transferência arbitrária | saldo e transactions |
| Criar Trade | `{ actorCharacterLinkId, targetCharacterId, offer: { gold, items: [{ itemId, quantity }] } }` | Trade e lista C/trades |
| Alterar oferta | PUT `{ characterLinkId, gold, items }` | GET Trade com `characterLinkId` |
| Aceitar Trade | `{ characterLinkId, counterpartyOfferVersion }` da oferta que a pessoa viu | Trade + wallet; 409 exige rever oferta |
| Cancelar Trade | `{ characterLinkId }` | Trade + wallet; AWAITING não permite cancelamento Player |
| Criar listing | `{ characterLinkId, itemId, quantity, priceGold }` | C/marketplace/listings; PENDING_CUSTODY não é anúncio comprável |
| Marketplace purchase/cancel | `{ characterLinkId }` | listas próprias, purchases e wallet; detalhes públicos só disponíveis enquanto compráveis |
| Browse Marketplace | query opcional `gameServerId`, `minPrice`, `maxPrice`, `page`, `limit` | reler browse; eventos não são broadcast público de catálogo |
| Chat send (todos canais) | `{ characterLinkId, message }`; target/group/guild na rota; texto plano | histórico do canal; dedup messageId; renderizar texto escapado |
| Settings | PATCH parcial: `locale`, `timeZone`, `allowDirectMessages`, `allowTradeRequests`, `allowGroupInvites`, `allowGuildInvites` | GET P/settings; campos de instalação/perfil local não pertencem aqui |
| VIP | apenas GET do catálogo e dos direitos do account/character | direitos efetivos; grant não significa entrega física confirmada |

No Trade com itens, `COMPLETED` significa fulfillment físico confirmado e GOLD
liquidado (11.4). Marketplace mantém seu lifecycle e a release persistente para
custody adquirida confirmada após cancelamento/falha. O Electron não envia
DOMAIN_EVENT nem resolve work do Agent. Wallet sempre vem do ledger; não somar
GOLD de snapshots do jogo ao saldo do backend. VIP PLAYER não escolhe personagem
automaticamente, e o painel não presume direito ativo apenas por receber evento
antigo de grant: refaz GET.

### Recuperação de Groups (11.6)

A 11.5 registrou que um cliente sem groupId não conseguia descobrir seus grupos
atuais. Confirmado na 11.6 que não havia rota equivalente (só GET por groupId e
invites pendentes), foi criada a menor leitura possível, espelhando a de Guild:

`GET /api/v1/player/me/characters/:characterLinkId/group` → `{ "group": GroupDto | null }`

- PlayerAuthGuard; o link precisa ser do Player autenticado e VERIFIED. Link
  desconhecido, de outra conta, PENDING ou REVOKED → o mesmo 404. Não existe
  parâmetro playerId.
- O banco garante no máximo uma membership ativa por character link (índice
  parcial `player_group_members_active_key`), então a resposta é um grupo
  opcional, não uma lista. Um Player com vários characters faz uma chamada por
  character do diretório.
- Retorna só o grupo ACTIVE atual, com a mesma projeção do GET por groupId; não é
  histórico. Após sair ou após o disband, volta `{ "group": null }`.
- `Cache-Control: no-store`, sem Audit, sem migration.

## GameServer discovery e disponibilidade remota

`GET /api/v1/player/game-servers` exige PlayerAuthGuard: sem token ou com token
Staff → 401; conta SUSPENDED/BANNED → 403. A resposta é a mesma projeção pública
para Players A e B, sem state da conta. Query aceita apenas page/limit. GET não
gera Audit e envia `Cache-Control: no-store`.

```json
{
  "items": [{
    "id": "<gameServerId UUID>",
    "code": "br-01",
    "name": "Skyrim Brasil",
    "enabled": true,
    "agentConnected": true,
    "gameProcessState": "RUNNING",
    "gameReady": true
  }],
  "total": 1,
  "page": 1,
  "limit": 20,
  "totalPages": 1
}
```

`code` e `name` são campos existentes de GameServer, não novos display fields.
Somente enabled=true entra na listagem. Omissão de um servidor **não revoga**
links nem apaga operações; histórico permanece acessível pelas APIs próprias
conforme a autorização existente.

| Situação persistida | agentConnected | gameProcessState | gameReady |
| --- | --- | --- | --- |
| Sem sessão Host Agent autenticada, desconectada ou heartbeat vencido | false | null | false |
| Host Agent conectado, Skyrim parado | true | STOPPED | false |
| Iniciando/reiniciando/parando/pausado/estado desconhecido | true | STARTING/RESTARTING/STOPPING/PAUSED/UNKNOWN | false |
| RUNNING sem SKSE pronto | true | RUNNING | false |
| RUNNING + SKSE pronto | true | RUNNING | true |
| GameServer disabled | não aparece | — | — |

Liveness usa a mesma fronteira de heartbeat do Game Bridge (igualdade com o
prazo já está stale). Read não escreve no banco para atualizar estado. Snapshots
velhos são ocultados; null significa runtime não observável, não que o processo
remoto foi comprovadamente parado. `gameReady` reutiliza a regra RUNNING +
skseReady, acrescida da sessão saudável. Não significa que toda capability esteja
suportada nem garante a conclusão de uma futura operação. Não há conexão,
credencial, capabilities, agentVersion, skseReady bruto ou configuração interna
na resposta. Não há evento de disponibilidade Player nesta etapa: use HTTP.

## Auth do Electron

Usar exclusivamente Player Auth existente. Nenhum segundo login ou Staff JWT.

1. Electron inicia o fluxo provider Discord no browser e valida `state` e o
   callback de sua tentativa. O callback/redirectUri precisa estar entre os
   `DISCORD_REDIRECT_URIS` configurados. Não existe endpoint backend que inicie
   esse browser/callback.
2. POST `/api/v1/player/auth/discord/exchange` com
   `{ authorizationCode, redirectUri, codeVerifier? }`. Backend troca o code com
   seu client secret, resolve/provisiona a conta e devolve `{ accessToken,
   refreshToken, expiresIn, refreshExpiresAt, player }`. `codeVerifier`, quando
   usado pelo fluxo validado, tem 43–128 caracteres RFC 7636. O suporte/encaixe
   real de PKCE e callback deve ser validado com os repos externos/provider;
   esta etapa não afirma que um cliente externo já o implementa.
3. GET `/api/v1/player/me` com accessToken retorna `id`, `displayName`, `status`
   e resumo de identities (`provider`, `linkedAt`), sem subject do provider.
4. POST `/api/v1/player/auth/refresh` com `{ refreshToken }` rotaciona o refresh
   na mesma sessão. Salve o par novo de forma consistente e serialize refreshes
   concorrentes; o refresh anterior não serve novamente. `refreshExpiresAt`
   não é estendido pela rotação. Reutilizar access antigo não substitui refresh.
5. POST `/api/v1/player/auth/logout` com accessToken revoga a sessão e retorna
   204. Electron limpa tokens/cache privado e fecha seus sockets. Não presumir
   que logout force imediatamente o fechamento de todos os sockets existentes:
   a gateway autentica na conexão e fecha por expiração do access; HTTP confere
   sessão/conta a cada chamada.

Responsabilidade do cliente: proteger refresh token com armazenamento seguro do
SO, minimizar exposição do access token, não logar tokens/codes/challenges e não
passá-los ao Launcher para funções locais. A biblioteca e o mecanismo concreto
no Electron ficam para seu repo. Nunca colocar client secret Discord no cliente.

Exchange inválido ou sessão/token inválido → 401; suspensão/banimento → 403;
entrada inválida → 400; rate limit → 429; Discord não configurado/indisponível →
503. Em 401 de refresh, retornar ao login; em 403 não fazer loop de refresh.

## Realtime Player e reconciliação HTTP

Conectar `wss://<backend>/api/v1/realtime` (em desenvolvimento local, `ws`).
Sem query string ou token na URL. Primeiro frame:

```json
{ "type": "AUTH", "surface": "PLAYER", "token": "<accessToken>" }
```

Resposta: `{ "type": "AUTHENTICATED", "surface": "PLAYER", "expiresAt": "<ISO>" }`.
Enviar AUTH antes do timeout anunciado pela configuração (default 5s). Depois de
AUTH o cliente não envia mutations, subscriptions, ACK de evento ou refresh pelo
socket; qualquer frame adicional fecha com PROTOCOL_ERROR. Todas as mutations
vão por HTTP. Staff usa outra audience/surface e não recebe esses eventos.

Close codes: 4000 AUTH_TIMEOUT, 4001 UNAUTHORIZED (reason `SESSION_REVOKED`
quando o backend revoga a sessão Player do socket, por logout ou reuso de
refresh: não reconecte com o mesmo token; faça login de novo), 4002 TOKEN_EXPIRED,
4003 PROTOCOL_ERROR, 4004 CONNECTION_LIMIT (12.1: sockets demais para a mesma
conta); 1001 no shutdown. Desde a 12.1 (`docs/security.md`):
- o upgrade pode ser recusado com 403 (Origin de browser fora da lista), 429 (`Retry-After`) ou 503;
- um cliente sem header Origin (processo main do Electron) é julgado só pelo token;
- um renderer que usa o WebSocket do browser envia Origin (`file://`, `app://…`), que precisa estar em `REALTIME_ALLOWED_ORIGINS`;
- refresh Player em single-flight: um token rotacionado reapresentado depois da janela de graça revoga a sessão;
- queries de personagem e mutations de trade/marketplace têm limite por minuto por Player (429 com `Retry-After`). Em expiração, obtenha access válido e abra
novo socket. Em falha de rede, reconnect com backoff e jitter; não criar loop
agressivo nem assumir ordem/completude/exactly-once de eventos.

Envelope de domínio:

```json
{
  "eventId": "<UUID>",
  "type": "PLAYER_CHARACTER_LINK_UPDATED",
  "occurredAt": "<ISO timestamp>",
  "data": {
    "characterLinkId": "<UUID>",
    "gameServerId": "<UUID>",
    "characterExternalId": "<opaque id>",
    "status": "VERIFIED",
    "updatedAt": "<ISO timestamp>"
  }
}
```

Esse evento ocorre após commit de request/relink PENDING, confirmação VERIFIED
ou revogação REVOKED. Uma nova solicitação de challenge enquanto PENDING também
acorda as conexões da conta. updatedAt é o timestamp do vínculo; reemitir um
challenge PENDING não implica timestamp novo no link. Replay de confirmação
verificada e revoke já revogado não geram evento novo. Destinatário exclusivo:
playerId proprietário do vínculo, escolhido no backend e ausente do payload.
Não carrega challenge, hash, proof nem dados do Agent. O challenge só vem no POST
de criação e pode expirar sem mudança de status do link: usar challengeExpiresAt.
REVOKED some do diretório; GET `/player/character-links/:linkId` do dono continua
permitindo consultar esse estado.

Para operação, o mesmo envelope usa:

```json
{
  "operationId": "<UUID do GameCommand, como na Player API>",
  "status": "TIMEOUT",
  "errorCode": "EXECUTION_UNCERTAIN",
  "completedAt": "<ISO timestamp>"
}
```

`type = PLAYER_GAME_OPERATION_UPDATED`. Emitido na primeira transição terminal
SUCCEEDED/FAILED/TIMEOUT de um GameCommand com actor PLAYER, após commit. Inclui
falhas de dispatch/expiração no backend e UNCERTAIN remoto (persistido como
TIMEOUT/EXECUTION_UNCERTAIN). Não emite ACK, dispatch, retry interno, duplicate
RESULT nem dados de conexão. `errorCode` é null em sucesso. Nenhum result bruto
é enviado: resultados podem chegar a 64 KiB, enquanto o frame de realtime
permanece limitado a 16 KiB; os dois eventos novos têm menos de 1 KiB nos testes.
Destino é **requestedByPlayerId persistido**, mesmo que ownership do character
mude depois. Apenas esse ator pode ler sua operação histórica; commands Staff e
SYSTEM não geram esse evento Player.

Em qualquer evento, marcar estado afetado como desatualizado e refazer HTTP.
O evento significa apenas "algo mudou, faça refetch": é publicado **depois do
commit**, sem ordem global entre eventos, sem sequence e podendo chegar
duplicado ou não chegar. Nunca aplicar o payload como estado.
Não substituir um snapshot HTTP mais novo com payload de evento atrasado.
Após AUTHENTICATED/reconnect, refazer GET das telas relevantes e operações ainda
pendentes. Um evento pode chegar antes da resposta do POST: armazenar o
operationId da resposta e fazer GET inicial independentemente do evento.
Manter polling limitado/backoff para pendências, mesmo com socket conectado,
cobre a perda best-effort sem reconnect. Para snapshots novos de gameplay é
necessário novo POST; polling de GET só acompanha a operação já criada.

Não existe replay history, offset, fila persistente de WebSocket, subscribe por
playerId nem garantia multi-instance. HTTP/database é canônico; realtime é
wake-up. Falha de um listener não desfaz a transação nem cria Audit técnico.

### Matriz final de eventos existentes e novos

| Feature | Eventos exatos | Destinatários / refetch |
| --- | --- | --- |
| Character link (11.5) | PLAYER_CHARACTER_LINK_UPDATED | dono do link; link + diretório |
| Operações (11.5) | PLAYER_GAME_OPERATION_UPDATED | ator PLAYER original; GET operation |
| Groups | GROUP_CREATED, GROUP_INVITE_CREATED, GROUP_INVITE_ACCEPTED, GROUP_INVITE_DECLINED, GROUP_MEMBER_JOINED, GROUP_MEMBER_LEFT, GROUP_MEMBER_KICKED, GROUP_DISBANDED | participantes/convites definidos pelo domínio; grupo conhecido + invites |
| Guilds | GUILD_CREATED, GUILD_INVITE_CREATED, GUILD_INVITE_ACCEPTED, GUILD_INVITE_DECLINED, GUILD_INVITE_CANCELLED, GUILD_MEMBER_JOINED, GUILD_MEMBER_LEFT, GUILD_MEMBER_KICKED, GUILD_MEMBER_ROLE_CHANGED, GUILD_MASTER_TRANSFERRED, GUILD_DISBANDED | participantes/convites; C/guild, detail e invites |
| Trade | TRADE_CREATED, TRADE_OFFER_UPDATED, TRADE_ACCEPTED, TRADE_AWAITING_GAME_CONFIRMATION, TRADE_COMPLETED, TRADE_CANCELLED, TRADE_FAILED | partes; trade/lista e wallet |
| Marketplace | MARKETPLACE_LISTING_ACTIVE, MARKETPLACE_LISTING_CANCELLED, MARKETPLACE_LISTING_RESERVED, MARKETPLACE_LISTING_SOLD, MARKETPLACE_LISTING_FAILED, MARKETPLACE_PURCHASE_FAILED | partes escolhidas pelo domínio; listings/purchases próprios + wallet; não broadcast do browse |
| Chat | CHAT_MESSAGE_CREATED | audiência do canal, definida pelo backend; contém mensagem segura em texto plano, mas histórico HTTP continua canônico |
| Settings | PLAYER_SETTINGS_UPDATED | própria conta; GET settings |
| VIP | VIP_ENTITLEMENT_GRANTED, VIP_ENTITLEMENT_REVOKED | conta ou dono do character conforme scope; GET direitos efetivos; não são eventos de delivery |
| Auth, discovery, XP/profissões, Wallet isolado, catálogo VIP/expiração | nenhum dedicado | HTTP periódico/manual/reconnect conforme feature |

Não adicionar evento Wallet duplicado: Trade/Marketplace já acordam o painel,
que refaz GET wallet. Alterações econômicas de outras origens não têm wake-up
próprio. Não confundir esses eventos com DOMAIN_EVENT/WORK_SYNC do Host Agent.

## Startup recomendado

1. Iniciar Electron, restaurar/revalidar Player session (refresh quando necessário).
2. Conectar realtime Player e aguardar autenticação; se falhar, seguir com HTTP.
3. Carregar `/player/me` e `/player/settings`.
4. Carregar discovery de GameServers (todas as páginas necessárias).
5. Carregar diretório de characters e reconciliar vínculos conhecidos.
6. Carregar estado das features relevantes; refazer GET de operações pendentes
   conhecidas, guild/invites, group por character (C/group), Trade/Marketplace,
   wallet, direitos VIP e histórico Chat. Não disparar queries Skyrim ilimitadas.
7. Conectar IPC local ao Launcher, negociar versão/capabilities locais.
8. Pedir status/installation state e reconciliar operações locais; apresentar o
   painel com disponibilidade por feature. Launcher indisponível não bloqueia
   account, chat, settings, wallet ou outras leituras HTTP autorizadas.

## Cold start sem cache local (11.6)

Cenário: Electron recém-instalado, sem nenhum ID guardado e sem histórico de
realtime. Com apenas Player Auth + HTTP o painel reconstrói tudo; realtime não
conta para a reconstrução inicial. Verificado em
`test/stage11-integration.e2e-spec.ts` com um novo login da mesma conta.

| Área | Reconstrução por HTTP |
| --- | --- |
| GameServers | GET P/game-servers (paginado) |
| Characters | GET P/me/characters → characterLinkId de cada character; GET P/character-links/:linkId para REVOKED conhecido |
| Groups | GET C/group por character (11.6) + GET P/group-invites |
| Guilds | GET C/guild + GET P/guild-invites?characterLinkId=… |
| Wallet | GET C/wallet (+ /transactions) |
| Trade | GET C/trades |
| Marketplace | GET C/marketplace/{listings,purchases} + browse GET P/marketplace/listings |
| Settings | GET P/settings |
| VIP | GET P/vip/entitlements + GET C/vip/{entitlements,effective} |

**Operações Player pendentes:** não foi criada listagem. Toda operação Player é
uma query read-only (`PLAYER_CHARACTER_QUERY_TYPES`, todas QUERY em
`COMMAND_KINDS`); perder o operationId de uma query pendente não deixa estado
irrecuperável nem efeito pendurado, porque a query termina sozinha (resultado ou
deadline) e um novo POST obtém um snapshot equivalente. Operações que mudam
estado do Player (Trade, Marketplace, VIP) já são recuperáveis pelas próprias
entidades acima. Uma listagem de operações fica para quando existir operação
Player que não seja query.

## Electron ↔ C# Launcher: fronteira local

Electron e C# Launcher não estão neste repositório. A 11.5 fecha apenas os
contratos e gaps do Backend. Admin Web e Electron são consumidores independentes;
não existe Electron → Admin Web nem Admin Web → Electron.

| Componente | Responsabilidade |
| --- | --- |
| Electron | UI, fluxo Player Auth, HTTP/realtime, solicitações locais tipadas ao Launcher e apresentação de progresso |
| Launcher local | localizar instalação Skyrim/paths, verificar executáveis, integridade e arquivos/mods, downloads/updates, load order/perfil local, iniciar jogo, observar processo e operações locais |
| Backend | regras online, ownership, economia e estado remoto; não recebe paths locais, não acessa filesystem do Player, não inicia processos nem gerencia mod files no PC |
| Host Agent remoto | runtime do Skyrim no **servidor** e execução/provas confiáveis; não é o Launcher do Player |

`gameReady` de discovery descreve Skyrim no servidor remoto. Installation/process
state do Launcher descreve o PC local. São estados independentes; nunca converter
um em outro. Ter jogo local aberto não autentica Agent nem comprova ownership.

### Requisitos de IPC (contrato a validar, não implementação)

Transporte ainda não escolhido: local-only, sem exposição remota, com validação
da contraparte/processo local, versão negociada, request/response tipados,
events/progress tipados, requestId/correlationId, limites de payload, timeouts e
códigos de erro fechados. UI não escolhe destinos remotos ou executáveis livres.
Nomes e shapes finais, limites numéricos e garantias de cancelamento/idempotência
precisam ser validados no repo real do Launcher.

Capacidades conceituais mínimas, **não endpoints Backend nem métodos congelados**:

| Capacidade | Semântica esperada |
| --- | --- |
| GET_STATUS | disponibilidade/versão/capabilities locais, processo e operações locais |
| GET_INSTALLATION_STATE | instalação detectada, validação de executáveis/arquivos e perfil local |
| CHECK_UPDATE | verificar versões/manifests aprovados; não aceitar URL/script arbitrário como comando |
| APPLY_UPDATE | aplicar atualização local validada; operação longa com progresso |
| SYNC_GAME_FILES/MODS | sincronizar conjunto/perfil permitido, com integridade e progresso |
| LAUNCH_GAME | iniciar executável validado da instalação/perfil conhecido |
| CANCEL_LOCAL_OPERATION | pedir cancelamento por operationId, somente onde a operação suportar |

São explicitamente proibidas APIs genéricas como
`{ command: "powershell ..." }`, raw shell, command string ou
`{ path: "...", execute: "..." }` para executar paths arbitrários. Operações devem
ser fechadas e tipadas. Os paths que o Launcher precisa tratar permanecem locais;
não viram parâmetro de API Backend nem instrução executável vinda de mensagem.

Operações longas retornam uma identidade local e emitem progresso conceitual
`{ operationId, state, progress?, messageCode? }`. messageCode serve para
apresentação, nunca lógica executável. Limites, unidades de progresso e catálogo
de states/errors precisam ser acordados com o código externo. Repetição de
request não pode inadvertidamente iniciar dois updates/launches; definir
idempotência por operação no contrato externo.

Após restart do Launcher, Electron reconecta, negocia versão, pede status e
reconcilia as operações conhecidas. Não inferir sucesso por desconexão ou
cancelamento solicitado; consultar estado final. Não reenviar automaticamente
launch/update com resultado desconhecido antes dessa reconciliação.

## Degradação e recuperação

| Falha | Comportamento do Electron |
| --- | --- |
| Backend offline | features online indisponíveis; cache identificado como desatualizado; Launcher pode informar/operar estado local conforme produto |
| Launcher offline/incompatível | painel HTTP/realtime continua navegável; instalação/update/launch local indisponíveis; reconectar e reconciliar |
| Realtime offline | HTTP continua; polling/backoff e refresh manual; após reconnect refetch, sem esperar replay |
| Agent remoto offline/runtime não pronto | gameplay queries podem ficar PENDING até limite e terminar FAILED/DISPATCH_EXPIRED; work de Trade/Marketplace segue pendente conforme domínio; account/chat/settings e leituras autorizadas continuam |
| GameServer disabled | oculto da discovery; preservar histórico pelos endpoints próprios; novas operações seguem recusas de domínio |
| Ownership mudou | novas ações exigem link atual VERIFIED; 404 em recursos que perderam acesso; operações históricas permanecem do ator original |

## Segurança, validação e decisões abertas

Payloads dos novos eventos são allowlists pequenas; nunca result/challenge/hash,
playerId, dados de sessão Agent ou credenciais. PlayerA não recebe dados de
PlayerB, e surface STAFF não recebe Player events. Não há Audit por discovery ou
notificação. Audit dos domínios permanece uma vez por efeito já previsto.

A bateria final `test/stage11-integration.e2e-spec.ts` (11.6) repete os fluxos
Player ponta a ponta junto com Staff/Agent, prova o cold start acima, a
recuperação offline sem replay e a separação de credenciais entre superfícies.

A suíte `test/electron-integration.e2e-spec.ts` exercita login Player → discovery →
challenge → DOMAIN_EVENT → evento owner-only → GET; Player query → COMMAND_RESULT
→ evento terminal → GET; também inclui ownership alterado, rollback/commit,
payload maior que o frame, duplicate, Staff isolation, expirações e recuperação
HTTP de eventos perdidos. Não valida Electron/Launcher externos nem SKSE real.

Persistência inalterada: 25 migrations, nenhuma nova na 11.5 nem na 11.6,
synchronize=false.

Decisões externas/pendentes (a de Groups foi resolvida na 11.6):
OAuth callback/PKCE no cliente real; transporte, segurança local, versões,
limites/shapes e catálogo final de IPC; fontes/manifests e política de update;
comportamento de launch totalmente offline; listagem Player de operações
(desnecessária enquanto só existirem queries); distribuição multi-instance do
realtime (Etapa 12).
Timeout/ação de operador para Trade/Marketplace, retry de VIP FAILED/UNCERTAIN e
target claim PLAYER permanecem fora da 11.5. Nenhuma dessas decisões implica
endpoint, migration ou implementação externa criada aqui.
