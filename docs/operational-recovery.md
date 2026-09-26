# Operational recovery — 12.4

Ferramentas Staff para os incidentes operacionais que, até a 12.3, só se
resolviam com SQL manual. A regra que decide cada ação: **nenhuma intervenção
de operador duplica um efeito físico (no jogo) ou econômico (GOLD)**. Onde o
backend não consegue provar que um efeito não aconteceu, a ação é inspecionar,
reconhecer e registrar a conclusão do operador, nunca reenviar.

Código: `src/operations/` (controller, `OperatorActionService`,
`RecoveryService`, `PlayerModerationService`, `OperationsQueryService`).
Migration: `1790050000000-OperationalRecovery` (26ª, forward-only).
Testes: `test/operational-recovery.e2e-spec.ts`, `src/operations/operations.spec.ts`.

## 1. Matriz de segurança (levantamento antes da implementação)

"Retry" significa criar de novo o efeito; "requeue" significa oferecer ao Agent
o mesmo trabalho, com o mesmo `workId`, cujo journal torna a repetição inócua.

| Situação | Garantia de origem | Prova de "sem efeito"? | Ação segura (12.4) | Ação insegura (não existe) |
| --- | --- | --- | --- | --- |
| Server Control `UNCERTAIN` | at-most-once; o claim é a fronteira | não: pode ter executado | listar, inspecionar, **resolver** (`RESOLVED_SUCCEEDED`/`RESOLVED_FAILED`) em colunas separadas | retry, novo pedido automático, sobrescrever status/erro |
| GameCommand Staff `TIMEOUT`/`EXECUTION_UNCERTAIN` (mutations) | at-least-once por commandId | não | inspecionar (`GET game-commands`, já existente) | retry com novo commandId |
| GameCommand `FAILED` remoto (`EXECUTION_FAILED`, `BRIDGE_ERROR`) | reportado depois da entrega | não (pode haver efeito parcial) | inspecionar | retry |
| Trade `AWAITING_GAME_CONFIRMATION` parado | GOLD em escrow; itens no Agent | — | listar, inspecionar, **REQUEUE_SAME_WORK** | cancelar, liquidar, novo trade, GOLD manual, auto-fail por idade |
| Listing `PENDING_CUSTODY` parada | custódia só pelo Agent | não (o Agent pode ter tirado o item) | listar, **REQUEUE_SAME_WORK** | cancelar pelo Staff |
| Purchase `AWAITING_GAME_CONFIRMATION` parada | GOLD em escrow | — | listar, **REQUEUE_SAME_WORK** | liquidar/reembolsar pelo Staff |
| Release `PENDING` parada | devolução pelo Agent | — | listar, **REQUEUE_SAME_WORK** | nova release (UNIQUE(listing_id)), resolução manual |
| Release `FAILED` | o Agent declarou falha definitiva | não sabemos onde o item está | **ACKNOWLEDGE**, **resolução manual** | retry (o `workId` já é final no journal do Agent; UNIQUE(listing_id) proíbe outra release) |
| VIP delivery `FAILED` com código pré-entrega | o command nunca saiu de `PENDING` | **sim** (ver §5.7) | **RETRY_SAFE** (nova tentativa, novo command) | — |
| VIP delivery `FAILED` remoto / sem command | pode ter executado / sem comando tipado | não / — | resolução (`CONFIRMED_*`); retry só após `CONFIRMED_NOT_DELIVERED` | retry cego |
| VIP delivery `UNCERTAIN` | TIMEOUT/EXECUTION_UNCERTAIN | não | resolução; retry só após `CONFIRMED_NOT_DELIVERED` | retry cego |
| VIP delivery `PENDING` preso | aguarda Agent pronto | — | inspecionar (o worker cria o command quando houver Agent) | forçar |
| Receipts `REJECTED` finais | dedup por eventId | — | listar (sem payload, sem hash) | editar, reprocessar |
| `CONFLICT` de DOMAIN_EVENT | não persistido por desenho | — | métrica `domain_events_total{outcome="conflict"}` | — |
| Conta Player | `players.status` + sessões | — | **SET_STATUS** com revogação de todas as sessões | SQL manual |
| Saldo | ledger append-only | — | **ADJUST** (CREDIT/DEBIT) por lançamento balanceado | "set balance", UPDATE em `economy_accounts` |
| Chat | mensagens append-only | — | **HIDE** (moderação), conteúdo preservado | delete |
| Entitlement `PLAYER` sem alvo de personagem | sem snapshot de alvo | — | **adiado** para a 12.7 / produto (§5.14) | escolher personagem pelo backend |

## 2. Permissões

Uma permissão estreita por domínio; o `PermissionGuard` segue fail-closed e
cada rota declara exatamente uma permissão (teste estrutural).

| Permissão | Rotas | Roles |
| --- | --- | --- |
| `OPERATIONS_READ` | `summary`, `domain-event-receipts` | COORDINATOR, GENERAL_CHIEF, DEV |
| `SERVER_CONTROL_RESOLVE` | fila e resolução de UNCERTAIN (+ a permissão do tipo da operação) | COORDINATOR, DEV |
| `PLAYER_TRADE_RECOVER` | fila de trades e requeue | COORDINATOR, GENERAL_CHIEF, DEV |
| `PLAYER_MARKETPLACE_RECOVER` | filas de custódia, settlement, release; requeue, acknowledge, resolve | COORDINATOR, GENERAL_CHIEF, DEV |
| `VIP_DELIVERY_RECOVER` | fila VIP, detalhe, retry, resolve | COORDINATOR, GENERAL_CHIEF |
| `PLAYER_ACCOUNT_MODERATE` | conta Player e status | COORDINATOR, GENERAL_CHIEF, ADMIN |
| `PLAYER_ECONOMY_ADJUST` | carteira e ajuste | COORDINATOR |
| `PLAYER_CHAT_MODERATE` | mensagens e hide | COORDINATOR, GENERAL_CHIEF, ADMIN, MODERATOR |

SUPPORT não recebe nenhuma. DEV recebe só recuperação de transporte (Server
Control e requeue de work), nunca economia, conta, recompensa ou chat.
Token Player, segredo de Agent ou nenhum token: 401.

## 3. Modelo comum de ação de operador

Toda mutação é `POST /api/v1/operations/...` com:

- `Idempotency-Key` obrigatório (1–128 ASCII `A-Za-z0-9._:-`), por usuário Staff;
- `reason` obrigatório: texto de uma linha, 1–500 caracteres, sem controle;
  vai para `operator_actions` e para o Audit, nunca para o Player;
- DTO estrito (campo desconhecido → 400) e UUIDs validados na rota;
- rate limit por usuário Staff (`OPERATIONS_ACTION_RATE_LIMIT_PER_MINUTE`, 429
  com `Retry-After`).

Execução (`OperatorActionService.run`), numa única transação:

1. insere a linha de `operator_actions` (`staff_id`, key, fingerprint SHA-256
   do pedido canônico). Um pedido concorrente com a mesma key espera no índice
   único e depois responde como replay; nunca chega ao domínio;
2. trava a linha do domínio (`FOR UPDATE`) ou usa update condicional e confere
   o estado: no máximo **uma** resolução por item, mesmo com operadores
   concorrentes (o segundo recebe 409);
3. aplica o efeito permitido;
4. grava o Audit `SUCCESS` (ator STAFF da sessão; `resource_id` = entidade;
   metadados só com ids, enums e o `reason`, nunca payload do Agent);
5. commit. Depois do commit: dicas ao Agent (requeue), fechamento de realtime
   (conta), wake-up `STAFF_OPERATIONS_UPDATED`.

Falha em qualquer passo (inclusive o Audit, 503) desfaz tudo; recusas (404,
409, 503) ficam no Audit como `FAILURE` com o status, sem mensagem.

Resposta: o resultado explícito do domínio mais `operatorActionId`, `domain`,
`action`, `resourceId`, `outcome` e `replayed`. O replay devolve o resultado
guardado com `replayed: true`; a mesma key com outro pedido é 409.

Tipos de ação: `RETRY_SAFE`, `REQUEUE_SAME_WORK`, `ACKNOWLEDGE`,
`RESOLVE_SUCCEEDED`, `RESOLVE_FAILED`, `CANCEL` (reservado: nenhum domínio o
oferece na 12.4), `SET_STATUS`, `ADJUST`, `HIDE`.

## 4. Endpoints

Prefixo `/api/v1/operations`. Filas paginadas (`page`, `limit ≤ 100`), da mais
antiga para a mais nova, com `ageSeconds` e `stale`.

| Método e rota | Permissão | Efeito |
| --- | --- | --- |
| `GET summary` | OPERATIONS_READ | contagem, `stale` e idade mais antiga de cada fila |
| `GET domain-event-receipts?gameServerId&kind` | OPERATIONS_READ | receipts `REJECTED` (kind, reason, eventId, data) |
| `GET server-control/uncertain?gameServerId&resolved` | SERVER_CONTROL_RESOLVE | operações UNCERTAIN dos tipos que o chamador lê |
| `POST server-control/:operationId/resolve` `{resolution, reason}` | SERVER_CONTROL_RESOLVE + tipo | resolução separada; status e errorCode intactos |
| `GET trades/awaiting?gameServerId` | PLAYER_TRADE_RECOVER | trades AWAITING com escrow reservado, linhas de item e última rejeição do Agent |
| `POST trades/:tradeId/requeue` `{reason}` | PLAYER_TRADE_RECOVER | REQUEUE_SAME_WORK |
| `GET marketplace/custody` · `POST marketplace/custody/:listingId/requeue` | PLAYER_MARKETPLACE_RECOVER | listing PENDING_CUSTODY |
| `GET marketplace/settlements` · `POST marketplace/settlements/:purchaseId/requeue` | PLAYER_MARKETPLACE_RECOVER | purchase AWAITING |
| `GET marketplace/releases?status&resolved` | PLAYER_MARKETPLACE_RECOVER | releases PENDING/FAILED |
| `POST marketplace/releases/:releaseId/requeue` | PLAYER_MARKETPLACE_RECOVER | só PENDING |
| `POST marketplace/releases/:releaseId/acknowledge` | PLAYER_MARKETPLACE_RECOVER | só FAILED; nenhuma mudança de estado |
| `POST marketplace/releases/:releaseId/resolve` `{resolution, reason}` | PLAYER_MARKETPLACE_RECOVER | só FAILED, uma vez |
| `GET vip-deliveries?status&resolved` · `GET vip-deliveries/:id` | VIP_DELIVERY_RECOVER | evidência do command, `retryable`, tentativas anteriores |
| `POST vip-deliveries/:id/retry` `{reason}` | VIP_DELIVERY_RECOVER | RETRY_SAFE (§5.7) |
| `POST vip-deliveries/:id/resolve` `{resolution, reason}` | VIP_DELIVERY_RECOVER | `CONFIRMED_DELIVERED` / `CONFIRMED_NOT_DELIVERED` |
| `GET players/:playerId` · `POST players/:playerId/status` `{status, reason}` | PLAYER_ACCOUNT_MODERATE | §5.11 |
| `GET economy/:gameServerId/wallets/:characterExternalId` · `POST economy/adjustments` | PLAYER_ECONOMY_ADJUST | §5.12 |
| `GET chat/messages?gameServerId&channel&senderCharacterId&hidden` · `GET chat/messages/:id` · `POST chat/messages/:id/hide` | PLAYER_CHAT_MODERATE | §5.13 |

Não existem rotas de retry para Server Control, GameCommand, trade, purchase,
custódia ou release (404).

## 5. Runbooks

Formato: **Sinal** (alerta ou fila) → **Inspeção** → **Ação segura** →
**Ação insegura** → **Verificação** → **Evidência de Audit** → **Escalonamento**.
Classificar como "stale" (`OPERATIONS_STALE_AFTER_MS`) só prioriza a fila:
**nada falha, é reenviado ou some por idade**.

### 5.1 Server Control UNCERTAIN

- Sinal: `server_control_uncertain_total` aumentou; `recovery_unresolved{domain="server_control"} > 0`; fila `server_control_uncertain` no summary.
- Inspeção: `GET operations/server-control/uncertain?resolved=false`; `errorCode` (`RESULT_TIMEOUT`, `OUTCOME_UNKNOWN`), `dispatchedAt`, `completedAt`. Verificar o processo real no host (fora do backend).
- Ação segura: `POST server-control/:id/resolve` com `RESOLVED_SUCCEEDED` (a ação ocorreu) ou `RESOLVED_FAILED` (não ocorreu). Se ainda for preciso agir, é um **novo pedido** Staff comum (START/PAUSE/RESTART), decidido pelo operador depois da verificação.
- Ação insegura: repetir o pedido antes de verificar; editar a linha.
- Verificação: a operação continua `status=UNCERTAIN`, com `resolution` e `resolvedAt` (também em `GET /server-control-operations/:id`); o gauge `server_control_operations{status="UNCERTAIN"}` deixa de contá-la; `server_control_uncertain_total` não muda (histórico).
- Audit: `SERVER_CONTROL_UNCERTAIN_RESOLVED`, recurso `SERVER_CONTROL`, `resolution` e `reason`.
- Escalonamento: host inacessível ou estado indeterminável → não resolver; DEV/infra.

### 5.2 GameCommand Staff TIMEOUT / FAILED

- Sinal: `game_command_terminal_total{status="TIMEOUT"}`; filas do Admin Web.
- Inspeção: `GET /api/v1/game-commands?status=TIMEOUT` (existente, GAME_BRIDGE_READ), `errorCode`.
- Ação segura: nenhuma mutação. Para mutations, verificar no jogo; se o efeito faltar, o operador cria um novo pedido pelo fluxo normal (novo commandId, auditado como pedido novo).
- Ação insegura: retry automático com novo commandId (não existe).
- Audit: o pedido novo, se houver.

### 5.3 Trade AWAITING_GAME_CONFIRMATION parado

- Sinal: `work_oldest_age_seconds{work="trade_settlement"}`; fila `trade_settlement` com `stale`.
- Inspeção: `GET operations/trades/awaiting` → `agentConnected`, `lockedAt`, `reservedGold`, `itemLines`, `lastRejection` (motivo do Agent, ex. `LEDGER_REJECTED`, `TRADE_NOT_AWAITING`, com contagem).
- Ação segura: com o Agent conectado, `POST trades/:id/requeue`: o backend esquece a dica de push daquele `workId` e o próximo tick o envia de novo; `WORK_SYNC` sempre o devolve. Não cria trade, settlement, escrow nem GOLD.
- Ação insegura: cancelar, liquidar, reembolsar ou mover GOLD à mão; falhar por idade.
- Verificação: `status` continua AWAITING até o `TRADE_SETTLEMENT` do Agent; contagem de `player_trades` e `economy_transactions` inalterada.
- Audit: `AGENT_WORK_REQUEUED`, recurso `PLAYER_TRADE`, `agentConnected`.
- Escalonamento: `lastRejection=LEDGER_REJECTED` persistente (ex. teto de saldo) → produto/COORDINATOR decide; o Agent real e seu journal (12.7).

### 5.4 Listing PENDING_CUSTODY / Purchase AWAITING / Release PENDING parados

Mesmo procedimento da §5.3 com `marketplace/custody`, `marketplace/settlements`
e `marketplace/releases?status=PENDING`, e os requeues correspondentes. O
vendedor ainda pode cancelar uma listing `PENDING_CUSTODY` pelo fluxo Player;
o Staff não cancela (o item pode já estar em custódia).

### 5.5 Release FAILED

- Sinal: `work_backlog{work="marketplace_release_failed"} > 0` (só não resolvidas); `recovery_unresolved{domain="marketplace_release"}`.
- Inspeção: `GET marketplace/releases?status=FAILED&resolved=false` (vendedor, item, quantidade, motivo, `errorCode=RELEASE_FAILED`).
- Ação segura: `acknowledge` ao assumir o caso (sem mudança de estado); depois de verificar no jogo, `resolve` com `RESOLVED_SUCCEEDED` (o item está com o vendedor) ou `RESOLVED_FAILED` (tratado fora do backend, ex. compensação decidida pelo produto).
- Ação insegura: retry/nova release. O `workId` é final no journal do Agent e `UNIQUE(listing_id)` impede outra release: um reenvio seria ignorado ou devolveria o item em dobro.
- Verificação: `status` e `release_event_id` intactos; `resolution` gravada; sai do gauge e da fila não resolvida.
- Audit: `PLAYER_MARKETPLACE_RELEASE_ACKNOWLEDGED`, `PLAYER_MARKETPLACE_RELEASE_RESOLVED`.
- Escalonamento: item perdido → produto (compensação via §5.12 se for GOLD).

### 5.6 VIP delivery FAILED/UNCERTAIN — inspeção

`GET vip-deliveries?status=FAILED|UNCERTAIN&resolved=false` e
`GET vip-deliveries/:id` mostram `commandStatus`, `commandErrorCode`,
`evidence` (`PRE_EFFECT_FAILURE`, `POSSIBLY_EXECUTED`, `NO_COMMAND`),
`retryable`, `attempt` e as tentativas anteriores.

### 5.7 VIP delivery FAILED antes de qualquer entrega — RETRY_SAFE

- Evidência exigida: o command da tentativa está `FAILED` com código que o
  dispatcher só grava enquanto o command está `PENDING` (nunca reservado nem
  entregue): `DISPATCH_EXPIRED`, `DISPATCH_REJECTED`, `DISPATCH_EXHAUSTED`,
  `GATEWAY_UNAVAILABLE`, `SERVER_DISABLED`.
- Ação: `POST vip-deliveries/:id/retry`. Na mesma transação (entitlement →
  delivery travados, a ordem do worker e do revoke): exige command anterior
  terminal (nunca dois commands vivos), entitlement ainda efetivo, reward
  tipado e `attempt < 10`; arquiva a tentativa em
  `vip_reward_delivery_attempts` (command, status, código, resolução) e volta a
  delivery a `PENDING` com `attempt + 1`. O worker cria o novo command com a
  chave `vip-delivery:<id>:<attempt>`; a tentativa 1 mantém `vip-delivery:<id>`.
- Verificação: nova linha em `game_commands`; `previousAttempts` no detalhe.
- Audit: `VIP_DELIVERY_RETRIED`, recurso `VIP_REWARD_DELIVERY`, código e command anteriores.

### 5.8 VIP delivery UNCERTAIN ou FAILED remoto

- Evidência: `POSSIBLY_EXECUTED` (TIMEOUT/`EXECUTION_UNCERTAIN`, `ACK_TIMEOUT`, `EXECUTION_FAILED`, `BRIDGE_ERROR`).
- Ação segura: verificar o personagem no jogo e `resolve`: `CONFIRMED_DELIVERED` fecha o caso (retry passa a ser recusado para sempre); `CONFIRMED_NOT_DELIVERED` registra a verificação e habilita `retry` (§5.7).
- Ação insegura: retry antes da resolução (409).
- `NO_COMMAND` (`UNSUPPORTED_REWARD`): não há comando tipado; só `CONFIRMED_NOT_DELIVERED` como registro; produto decide o reward.
- Audit: `VIP_DELIVERY_RESOLVED`.

### 5.9 VIP delivery PENDING preso

Sem Agent pronto com a capability, a delivery fica `PENDING` sem command (fila
`vip_delivery_open`). Ação: colocar o Agent em pé. Nenhuma mutação de operador.

### 5.10 Receipts REJECTED e CONFLICT

`GET domain-event-receipts?gameServerId&kind`: rejeições finais persistidas
(kind, reason, eventId, data), nunca payload nem hash. Rejeições retryable
(`LEDGER_REJECTED`, `SERVER_UNAVAILABLE`) não viram receipt; a última rejeição
de um work item existente (qualquer motivo que prove que o item existe no
servidor da sessão) fica em `agent_work_rejections` e aparece como
`lastRejection` nas filas. `CONFLICT` (mesmo eventId com outro conteúdo) não é
persistido: métrica `domain_events_total{outcome="conflict"}`. Nenhuma edição.

### 5.11 Conta Player: suspender, banir, reativar

- `POST players/:id/status` `{status: ACTIVE|SUSPENDED|BANNED, reason}`.
- Saindo de ACTIVE: na mesma transação, **todas** as sessões ativas são revogadas; depois do commit, `RealtimeSessionControl.playerAccountRevoked` fecha todos os sockets da conta (`4001 ACCOUNT_DISABLED`) e marca as sessões como revogadas no gateway (um AUTH em voo é recusado). O `requireActive` já bloqueava login, refresh e cada request.
- ACTIVE de novo **não revive sessão**: refresh tokens antigos continuam inválidos; o Player faz login.
- Mesmo status: `outcome=UNCHANGED` (sessões remanescentes ainda são revogadas se o status não for ACTIVE).
- Audit: `PLAYER_ACCOUNT_STATUS_CHANGED`, recurso `PLAYER_ACCOUNT`, status anterior e sessões revogadas.
- Não muda trades, listings ou entitlements em andamento (seguem o próprio ciclo).

### 5.12 Ajuste de GOLD

- `POST economy/adjustments` `{gameServerId, characterExternalId, direction: CREDIT|DEBIT, amount, externalReference, reason}`.
- Um lançamento `STAFF_ADJUSTMENT` balanceado contra a conta SYSTEM `ADJUSTMENT`, ator STAFF (CHECK no banco), chave `operator-action:<id>`, referência `STAFF_ADJUSTMENT/<externalReference>` (visível ao Player no histórico). Valor inteiro positivo ≤ 10¹²; nunca abaixo de zero nem acima do teto (409 `Adjustment rejected by the ledger: …`). Não existe "set balance".
- Só carteiras conhecidas (conta existente ou vínculo do personagem no servidor): um id digitado errado é 404 e não cria carteira.
- Correção de um ajuste = outro ajuste na direção oposta (o ledger é imutável).
- Audit: `ECONOMY_STAFF_ADJUSTED`, recurso `ECONOMY_TRANSACTION`, saldo resultante.

### 5.13 Moderação de chat

- `GET chat/messages?gameServerId` lista GLOBAL/GROUP/GUILD (DIRECT só por id, vindo de denúncia).
- `POST chat/messages/:id/hide`: grava `moderated_at`, `moderated_by_staff_id`, `moderation_reason`; todo histórico Player passa a ocultá-la. O conteúdo fica como evidência; o trigger continua proibindo qualquer outro update, desfazer o hide e o delete antes da expiração. Uma vez por mensagem.
- Audit: `PLAYER_CHAT_MESSAGE_HIDDEN`, sem o conteúdo.
- Sem evento realtime Player de remoção: clientes que já exibiram a mensagem só a perdem ao reler o histórico.

### 5.14 Entitlements PLAYER / anteriores à 11.4 — adiado

Um entitlement de escopo PLAYER não tem personagem-alvo e o backend não
escolhe um. O "claim" de alvo pelo Player exige contrato de produto (quem
escolhe, quando, se pode trocar) e fluxo Player/Electron: fica para a 12.7 /
produto. Entitlements CHARACTER anteriores à 11.4 não têm snapshot de reward:
mesmo destino.

## 6. Métricas e alertas

Em `docs/observability.md`: `operator_actions_total{domain,action,outcome}`,
`recovery_unresolved{domain}`, `recovery_resolved{domain}`,
`recovery_oldest_unresolved_age_seconds{domain}`; resoluções saem de
`server_control_operations{status="UNCERTAIN"}` e de
`work_backlog{work="marketplace_release_failed"}`; os counters históricos
continuam cumulativos. Labels só de enums.

## 7. Realtime

`STAFF_OPERATIONS_UPDATED` `{operatorActionId, domain, action, resourceId,
outcome}` depois de cada intervenção aceita, só para Staff com a permissão do
domínio. É wake-up: o cliente relê as filas por HTTP. Player: somente o
fechamento dos sockets na suspensão/banimento.

## 8. Limites conhecidos

- O requeue esquece a dica de push; o push só envia a primeira página de work
  de cada servidor. Com mais de 50 itens pendentes o item vem pelo `WORK_SYNC`
  do Agent.
- Em MULTI (12.5) o rate limit do operador é cluster-wide e o fechamento de
  sockets é propagado entre réplicas; em SINGLE ambos são do processo.
- `operator_actions.reason` e o Audit guardam texto do operador; o operador não
  deve colocar dados pessoais além do necessário.
