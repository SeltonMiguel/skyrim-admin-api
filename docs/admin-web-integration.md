# Admin Web integration contract — 11.6

Admin Web source code não está neste repositório. Este documento descreve o que o
Backend oferece ao Admin Web: as Staff APIs HTTP, o realtime Staff e como o
cliente se recupera de reconnect e de cold start. Não há UI aqui.

Rotas relativas a `/api/v1`. `S = /game-servers/:serverId`. Toda rota Staff usa
`Authorization: Bearer <Staff accessToken>` (login em `POST /auth/login`), com
`JwtAuthGuard` + `PermissionGuard`. Token Player ou credencial de Agent não
autenticam Staff (401). Mutations que criam operação exigem `Idempotency-Key`.

## Princípios

- **HTTP/database é a fonte de verdade.** Realtime Staff é um wake-up best
  effort: "algo mudou, refaça o GET". Não há replay, histórico, offset nem
  event sourcing pelo socket.
- **Publicado depois do commit.** Um evento nunca descreve algo que foi desfeito
  por rollback. Não há ordem global entre eventos nem sequence; duplicatas e
  perdas são possíveis. O cliente não aplica o payload como estado.
- **Payloads pequenos e planos** (< 1 KiB nos testes). Nunca result bruto de
  GameCommand, payload do Agent, WORK_ITEMS, histórico de chat, blob de Audit,
  credencial, hash, capabilities, connectionId, correlationId ou Idempotency-Key.
- **Nenhum privilégio novo.** Cada evento só chega a quem tem a permissão exigida
  pelo GET HTTP do mesmo recurso (ver abaixo). Não existe segundo RBAC.

## Matriz Staff

`P:` permissão exigida. "Wake-up" é o evento Staff que indica mudança; o fallback
vale sempre (socket fechado, evento perdido, cold start).

| Feature | HTTP reads | HTTP mutations | Permissão | Staff realtime wake-up | Polling/refetch fallback | Depende do Agent |
| --- | --- | --- | --- | --- | --- | --- |
| Auth/sessão | GET /auth/me | POST /auth/login, /auth/refresh, /auth/logout | sessão ativa | nenhum | revalidar /auth/me; socket fecha 4002 no fim do access token | não |
| Dashboard | GET /dashboard | nenhuma | DASHBOARD_READ | STAFF_GAME_SERVER_UPDATED e STAFF_GAME_OPERATION_UPDATED invalidam os contadores | GET periódico (janela fixa de 24 h) | não |
| Servers | GET /game-servers (filtros code, enabled, health), GET S | nenhuma HTTP (registro/habilitação fora da API) | GAME_BRIDGE_READ | STAFF_GAME_SERVER_UPDATED | GET S / lista periódica | não |
| Agent status | GET S (health + currentConnection com `gameProcessState`/`skseReady`, 11.6), GET S/connections | — | GAME_BRIDGE_READ | STAFF_GAME_SERVER_UPDATED | GET S | é o próprio estado do Agent |
| Agent credentials | GET /admin/game-servers/:gameServerId/agent-credentials | POST …/agent-credentials, POST …/:credentialId/revoke | GAME_AGENT_CREDENTIAL_MANAGE | revogação produz STAFF_GAME_SERVER_UPDATED (agentConnected=false) | GET lista | não |
| Game operations (genérico) | GET S/commands (filtros status, type, requestId, datas), GET /game-commands/:id | — | GAME_BRIDGE_READ | STAFF_GAME_OPERATION_UPDATED | GET S/commands?status=PENDING/DISPATCHED/ACKNOWLEDGED | sim, para executar |
| Characters | GET /character-operations/:commandId | POST S/characters/:characterId/{inventory/query, inventory/items/remove, inventory/items/give, properties/query, properties/grant, properties/revoke, holds/query, holds/grant, holds/revoke, horses/query, horses/give, horses/revoke, titles/give, spells/give, factions/query, factions/add, factions/remove} | CHARACTER_* / FACTION_* da operação | STAFF_GAME_OPERATION_UPDATED | GET da operação | sim |
| Moderation | GET /moderation-operations/:commandId | POST S/moderation/{players/:playerId/ban, players/:playerId/unban, players/:playerId/god-mode, staff/me/noclip, staff/me/invisibility, announcements, staff/me/teleport-to-player, players/:playerId/teleport-to-me} | PLAYER_BAN, PLAYER_UNBAN, PLAYER_GOD_MODE, STAFF_NOCLIP, STAFF_INVISIBILITY, ANNOUNCEMENT_SEND, STAFF_TELEPORT_TO_PLAYER, PLAYER_TELEPORT_TO_STAFF | STAFF_GAME_OPERATION_UPDATED | GET da operação | sim |
| World | GET /world-operations/:commandId | POST S/world/{state/query, time, weather, spawn} | WORLD_READ, WORLD_TIME_WRITE, WORLD_WEATHER_WRITE, WORLD_ENTITY_SPAWN | STAFF_GAME_OPERATION_UPDATED | GET da operação | sim |
| VIP catalog | GET /admin/vip-store/offers, GET /admin/vip-store/offers/:id | POST /admin/vip-store/offers, PATCH …/:id, PATCH …/:id/active | VIP_STORE_READ / VIP_STORE_WRITE | nenhum (mudança só por HTTP do próprio Staff) | refetch após a mutation | não |
| Server Control | GET S/control/operations (11.6; filtros status, type), GET /server-control-operations/:operationId | POST S/control/{start, pause, restart} | SERVER_START / SERVER_PAUSE / SERVER_RESTART do tipo | STAFF_SERVER_CONTROL_UPDATED | GET S/control/operations?status=… | sim (at-most-once) |
| Audit | GET /audit (filtros), GET /audit/:id | nenhuma | AUDIT_READ | nenhum | GET paginado sob demanda | não |
| Staff/RBAC | GET /staff, GET /staff/:id | POST /staff, PATCH /staff/:id, PATCH /staff/:id/role, PATCH /staff/:id/status | STAFF_READ / STAFF_WRITE | nenhum | refetch após a mutation | não |
| Operations / Recovery (12.4) | GET /operations/summary, filas e detalhes (ver "Operations / Recovery") | POST /operations/… (resolve, requeue, acknowledge, retry, status, adjustments, hide) | uma por domínio: OPERATIONS_READ, SERVER_CONTROL_RESOLVE, PLAYER_TRADE_RECOVER, PLAYER_MARKETPLACE_RECOVER, VIP_DELIVERY_RECOVER, PLAYER_ACCOUNT_MODERATE, PLAYER_ECONOMY_ADJUST, PLAYER_CHAT_MODERATE | STAFF_OPERATIONS_UPDATED | GET da fila / summary | requeue e retry VIP precisam do Agent para ter efeito |

As rotas tipadas de operação (`/character-operations`, `/moderation-operations`,
`/world-operations`) exigem a permissão do tipo gravado, não apenas
GAME_BRIDGE_READ. O GET genérico `/game-commands/:id` mostra status, errorCode e
metadados a quem tem GAME_BRIDGE_READ, sem payload nem result bruto.

## Realtime Staff

Conectar `wss://<backend>/api/v1/realtime` (sem token na URL) e enviar como
primeiro e único frame:

```json
{ "type": "AUTH", "surface": "STAFF", "token": "<Staff accessToken>" }
```

Resposta `{ "type": "AUTHENTICATED", "surface": "STAFF", "expiresAt": "<ISO>" }`.
Qualquer outro frame do cliente fecha com 4003. Close codes: 4000 AUTH_TIMEOUT,
4001 UNAUTHORIZED, 4002 TOKEN_EXPIRED, 4003 PROTOCOL_ERROR, 4004
CONNECTION_LIMIT (12.1: sockets demais para a mesma conta; os existentes ficam),
1001 shutdown. Um token Player na surface STAFF (ou Staff na PLAYER) é 4001.
Limite de frame 16 KiB, o mesmo do Player.

Desde a 12.1 (`docs/security.md`):
- o upgrade pode ser recusado antes do WebSocket: 403 para Origin fora de `REALTIME_ALLOWED_ORIGINS`, 429 com `Retry-After` para tentativas demais do IP, 503 quando o processo está no limite de sockets;
- a origem do Admin Web precisa estar em `CORS_ORIGINS` para as chamadas HTTP do browser;
- login e refresh Staff podem responder 429 genérico com `Retry-After`: respeite o tempo, não tente de novo em loop;
- refresh em single-flight: um token já rotacionado reapresentado depois de `AUTH_REFRESH_REUSE_GRACE_MS` revoga a sessão.

Envelope: `{ eventId, type, occurredAt, data }`. Os três tipos Staff:

### STAFF_GAME_SERVER_UPDATED — permissão GAME_BRIDGE_READ

```json
{
  "gameServerId": "<UUID>",
  "enabled": true,
  "agentConnected": true,
  "gameProcessState": "RUNNING",
  "gameReady": true,
  "updatedAt": "<ISO>"
}
```

Publicado quando o estado operacional **realmente muda**: Agent conectou,
desconectou, foi superseded (nova sessão), ficou stale, teve a credencial
revogada, ou mudou `gameProcessState`/`skseReady` (heartbeat ou resultado de
Server Control). Heartbeat sem mudança não publica nada. O estado é relido do
banco depois do commit (a mesma regra de frescor de `health`), comparado ao
último publicado por esta instância e serializado por servidor.
`gameProcessState` é null quando o Agent não está conectado. Não existe mutation
HTTP de habilitar/desabilitar servidor, então essa mudança não tem wake-up
próprio: o `enabled` aparece no próximo evento do servidor e no GET.

### STAFF_GAME_OPERATION_UPDATED — permissão GAME_BRIDGE_READ

```json
{
  "commandId": "<UUID>",
  "gameServerId": "<UUID>",
  "commandType": "CHARACTER_INVENTORY_QUERY",
  "status": "SUCCEEDED",
  "errorCode": null,
  "completedAt": "<ISO>"
}
```

Uma vez, na primeira transição terminal (SUCCEEDED, FAILED ou TIMEOUT, incluindo
deadline e falha de dispatch no backend) de um GameCommand com **actor STAFF**.
UNCERTAIN remoto chega como `TIMEOUT` + `EXECUTION_UNCERTAIN`. ACK, retry,
dispatch e RESULT duplicado não publicam. Commands PLAYER têm seu próprio evento
na surface Player e commands SYSTEM (entrega VIP) não publicam aqui. O result
fica no GET da operação.

### STAFF_SERVER_CONTROL_UPDATED — permissão do tipo (SERVER_START, SERVER_PAUSE ou SERVER_RESTART)

```json
{
  "operationId": "<UUID>",
  "gameServerId": "<UUID>",
  "type": "SERVER_RESTART",
  "status": "UNCERTAIN",
  "errorCode": "RESULT_TIMEOUT",
  "completedAt": "<ISO>"
}
```

Quando a operação fica terminal: `SUCCEEDED` (resultado do Agent), `FAILED`
(nunca entregue: SERVER_DISABLED, DISPATCH_EXPIRED, AGENT_UNAVAILABLE,
AGENT_REJECTED; ou falha definitiva reportada: DELIVERY_EXPIRED,
INVALID_PROCESS_STATE, EXECUTION_FAILED) ou `UNCERTAIN` (RESULT_TIMEOUT sem
resultado até o deadline, OUTCOME_UNKNOWN reportado pelo Agent). **UNCERTAIN é
distinto de FAILED**: a ação pode ter rodado, nunca é reenviada e exige atenção
do operador. Resultado duplicado não publica.

### Autorização dos destinatários

O destinatário precisa ter, **no momento da entrega**, a permissão indicada. O
gateway guarda o access token de cada socket Staff apenas em memória e, a cada
evento Staff, revalida sessão, status da conta e role atual pelo mesmo
`AuthService.authenticate` do HTTP. Não há cache de privilégio além de uma
verificação em voo por socket. Consequências:

- mudança de role vale para o próximo evento (DEV → SUPPORT deixa de receber
  Server Control e passa a receber 403 no GET);
- conta desabilitada ou sessão revogada: o socket fecha com 4001 na próxima
  entrega;
- falha de banco na verificação só pula aquela entrega.

Com o RBAC atual todos os roles têm GAME_BRIDGE_READ, então todo Staff recebe os
dois primeiros tipos; Server Control chega só a COORDINATOR e DEV.
`STAFF_OPERATIONS_UPDATED` (12.4) chega a quem tem a permissão do domínio da
intervenção. Staff nunca
recebe eventos Player (chat, settings, link, operações Player) e Player nunca
recebe `STAFF_*`: o bus descarta qualquer publicação com surface trocada.

### Backpressure

Frames são pequenos e o envio nunca bloqueia a transação (publicação pós-commit,
entrega assíncrona). Um socket com mais de 256 KiB ainda não lidos
(`MAX_REALTIME_BUFFERED_BYTES`) é derrubado em vez de acumular: o cliente
reconecta e refaz GET. Não há fila por cliente. Backpressure mais elaborado e
distribuição multi-instance ficam para a Etapa 12.

## Reconnect e cold start

Após `AUTHENTICATED` (inclusive após reconnect), refazer GET das telas abertas;
não esperar replay. O Admin Web inicia sem nenhum histórico de realtime e
reconstrói tudo por HTTP:

| Tela | Reconstrução |
| --- | --- |
| Dashboard | GET /dashboard |
| Server states | GET /game-servers (paginado, filtro health) |
| Agent status | GET S: `health`, `currentConnection.gameProcessState`, `currentConnection.skseReady` (11.6); histórico em GET S/connections |
| Operações pendentes/terminais | GET S/commands?status=PENDING (DISPATCHED, ACKNOWLEDGED…), GET da operação tipada |
| Server Control | GET S/control/operations (11.6): em voo (PENDING/DISPATCHED) e UNCERTAIN, sem conhecer ids |
| Audit | GET /audit |

Duas leituras foram adicionadas na 11.6 por serem essenciais e inexistentes:

1. **Runtime do Agent no GET de servidor.** `currentConnection` passou a trazer
   `gameProcessState` e `skseReady` persistidos (null em sessão sem Agent).
   Sem isso o Admin Web não sabia, sem realtime, se o Skyrim estava parado.
2. **`GET S/control/operations`.** Só existia GET por operationId. Como há no
   máximo uma operação não terminal por servidor, um Admin Web que perdeu o id
   recebia 409 em novos pedidos sem conseguir achar a operação que bloqueia;
   DEV não tem AUDIT_READ para encontrá-la pelo Audit. A lista exige ao menos
   uma permissão de Server Control, mostra só os tipos que o chamador pode ler
   (nem os conta), ordena `createdAt DESC, id DESC`, pagina como as demais
   (`page`, `limit ≤ 100`) e usa o índice existente
   `server_control_operations_server_idx`. Sem migration.

## Operations / Recovery (12.4)

Runbooks, matriz de segurança e regras completas em
`docs/operational-recovery.md`. Resumo para o cliente:

- **Rotas** sob `/operations`, cada uma com exatamente uma permissão do
  domínio. Filas paginadas (`page`, `limit ≤ 100`), da mais antiga para a mais
  nova, com `ageSeconds` e `stale` (só classificação, pelo
  `OPERATIONS_STALE_AFTER_MS`; nada falha por idade).
- **Toda mutação** é `POST` com `Idempotency-Key` e `reason` (1–500, uma
  linha). Resposta 200 com o resultado explícito e `operatorActionId`,
  `domain`, `action`, `resourceId`, `outcome`, `replayed`. Replay com a mesma
  key e o mesmo corpo → mesmo resultado, `replayed: true`; mesma key com outro
  corpo → 409. Estado que não aceita a ação (já resolvido, não está esperando o
  Agent, retry não comprovadamente seguro) → 409. 429 com `Retry-After` por
  usuário Staff. 503 = Audit indisponível, nada aplicado.
- **Nunca há retry cego.** Server Control UNCERTAIN e releases FAILED são
  resolvidos (registro separado; status original intacto); trade, custódia,
  settlement e release PENDING só recebem `requeue` (mesmo `workId`); VIP só
  aceita `retry` com `retryable: true` na fila (falha pré-entrega comprovada ou
  `CONFIRMED_NOT_DELIVERED` registrado antes).
- **Telas sugeridas:** summary como painel inicial; uma fila por domínio com a
  ação permitida por item; detalhe VIP com as tentativas anteriores; conta
  Player com status e sessões ativas; carteira com saldo antes do ajuste;
  moderação de chat por servidor.
- **Realtime:** `STAFF_OPERATIONS_UPDATED` `{operatorActionId, domain, action,
  resourceId, outcome}` para quem tem a permissão do domínio, depois do commit.
  É só wake-up: refazer o GET da fila. Não há replay; no cold start, GET
  summary e as filas abertas.
- **Server Control:** `GET /server-control-operations/:id` e a lista por
  servidor mostram `resolution` e `resolvedAt` (null até a resolução); `status`
  continua `UNCERTAIN`.

| Domínio | Leituras | Ações |
| --- | --- | --- |
| Visão geral | GET /operations/summary, GET /operations/domain-event-receipts | — |
| Server Control | GET /operations/server-control/uncertain | POST …/:operationId/resolve `{resolution: RESOLVED_SUCCEEDED\|RESOLVED_FAILED}` |
| Trade | GET /operations/trades/awaiting | POST …/:tradeId/requeue |
| Marketplace | GET /operations/marketplace/{custody, settlements, releases} | POST custody/:listingId/requeue, settlements/:purchaseId/requeue, releases/:releaseId/{requeue, acknowledge, resolve} |
| VIP | GET /operations/vip-deliveries, GET …/:deliveryId | POST …/:deliveryId/retry, POST …/:deliveryId/resolve `{resolution: CONFIRMED_DELIVERED\|CONFIRMED_NOT_DELIVERED}` |
| Conta Player | GET /operations/players/:playerId | POST …/:playerId/status `{status: ACTIVE\|SUSPENDED\|BANNED}` |
| Economia | GET /operations/economy/:gameServerId/wallets/:characterExternalId | POST /operations/economy/adjustments `{gameServerId, characterExternalId, direction: CREDIT\|DEBIT, amount, externalReference}` |
| Chat | GET /operations/chat/messages, GET …/:messageId | POST …/:messageId/hide |

## Dependência do Agent

Servers, Dashboard, Audit, VIP catalog e Staff/RBAC funcionam sem Agent.
Characters, Moderation e World criam GameCommands (at-least-once, dedup por
commandId no journal do Agent); ficam PENDING até um Agent pronto e com a
capability, e terminam FAILED/DISPATCH_EXPIRED se nenhum aparecer. Server Control
é at-most-once: sem Agent elegível fica PENDING e termina FAILED sem nunca ter
sido enviado; depois de enviado nunca é reenviado.

## Testes

`test/stage11-integration.e2e-spec.ts` cobre: GameServer wake-up e ausência de
evento em heartbeat igual; supersede, stale, revogação e reconnect Staff sem
replay; filtro de permissão com mudança de role e conta desabilitada; GameCommand
Staff ponta a ponta com SUCCEEDED/FAILED/TIMEOUT; Server Control SUCCEEDED,
UNCERTAIN, resultado após reconnect e FAILED antes da entrega; lista de Server
Control; restart real do backend; separação de credenciais entre surfaces.
