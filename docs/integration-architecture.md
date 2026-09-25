# Etapa 11 — Integration Architecture (11.0)

Documento de discovery e contratos. **Não há código, migration, endpoint ou
transporte nesta subetapa.** Ele inventaria o que as Etapas 00–10 deixaram pronto
para integração, fixa as decisões de transporte, autenticação, protocolo e
garantias de entrega do Game Agent, e distribui o trabalho restante entre as
subetapas 11.1–11.6.

Tudo o que é descrito como "proposto" ou "11.x" **não existe** no código. Tudo o
que é descrito como "atual" foi verificado neste repositório, com referência ao
arquivo. Código do Game Agent/SKSE, do Electron e do Launcher C# **não está neste
repositório**: para essas peças, 11.0 define somente o contrato esperado do lado
do backend e não valida nenhuma implementação real.

## 1. System boundaries

```text
Admin Web ──HTTPS /api/v1/...──────────────┐
          ──WS /api/v1/realtime (STAFF)────┤
                                           │
Electron ──HTTPS /api/v1/player/...────────┤        ┌──────────────┐
         ──WS /api/v1/realtime (PLAYER)────┼──────► │   Backend    │ ◄── PostgreSQL
    │                                      │        │ (NestJS)     │     (fonte de verdade
    │ local IPC (fora do backend)          │        └──────┬───────┘      de lifecycle,
    ▼                                      │               │              ledger, ownership)
C# Launcher                                │   WS /api/v1/agent (proposto, 11.1)
 (arquivos, mods, updates,                 │               │
  launch do Skyrim)                        │        ┌──────┴───────┐
                                           │        │  Host Agent  │ ◄─ local ─► SKSE plugin
                                           │        │ (por server) │            (dentro do Skyrim)
                                           │        └──────────────┘
```

| Fronteira | Direção | Transporte | Autenticação | Existe hoje? |
| --- | --- | --- | --- | --- |
| Admin Web ↔ Backend | bidirecional (HTTP + push) | HTTPS + WS `/api/v1/realtime`, surface `STAFF` | Staff JWT (`skyrim-admin-access`) | Sim |
| Electron ↔ Backend | bidirecional (HTTP + push) | HTTPS + WS `/api/v1/realtime`, surface `PLAYER` | Player JWT (`skyrim-player-access`) | Sim |
| Backend ↔ Host Agent | bidirecional | WS dedicado (proposto) | credencial própria do Agent (proposta) | **Não**: gateways Disconnected |
| Electron ↔ C# Launcher | local | IPC local | fora do backend | Fora deste repo |
| Host Agent ↔ SKSE | local | fora do backend | fora do backend | Fora deste repo |

Regras que 11.x preserva:

- O backend **não depende de Electron** (nenhum pacote, import ou rota específica).
- Electron **nunca fala com o banco**; consome apenas Player API e realtime.
- Admin Web e Electron **não conversam entre si**: são consumidores independentes.
- O Launcher/IPC local é uma fronteira **externa**; o backend não expõe rota para
  manipular filesystem, mods ou processos da máquina do jogador.
- O Agent é o único canal entre backend e runtime do Skyrim.

## 2. Current integration inventory

### 2.1 Game Bridge (`src/game-bridge/`)

| Peça | Arquivo | Estado |
| --- | --- | --- |
| `GameGateway` (abstrato) | `game-gateway.ts` | `send(connection, envelope, signal) → TransportAcceptance`; deve resolver em ≤ 1 s e honrar abort |
| `DisconnectedGameGateway` | `game-gateway.ts` | **provider de produção**; sempre `{ accepted: false, reason: 'UNAVAILABLE' }` |
| `GameServerService` | `game-server.service.ts` | registro/lock de `game_servers` (`id`, `code`, `name`, `enabled`) |
| `GameConnectionService` | `game-connection.service.ts` | `connect/heartbeat/disconnect/active/healthy/markStaleConnections`; uma conexão CONNECTED por servidor (índice parcial único) |
| `GameCommandBus` | `game-command-bus.ts` | `submit` / `submitInTransaction`: INSERT idempotente por `(game_server_id, idempotency_scope, idempotency_key)` |
| `GameCommandDispatcher` | `game-command-dispatcher.ts` | `dispatch/dispatchPending/retryTimedOutDispatches` com lease persistente |
| `GameCommandReceiver` | `game-command-receiver.ts` | `acknowledge/result/expireCommands` |
| `GameCommandStore` | `game-command-store.ts` | lock `game_servers → game_commands`, `finish`, `expireExecution`, recuperação de lease |
| Contratos | `command-contract.ts`, `command-state.ts`, `command-limits.ts` | `PROTOCOL_VERSION = "1"`, `CommandMap` fechado (32 tipos), envelopes, validação runtime |

**Lifecycle** (`command-state.ts`):

| Origem | Destino | Condição |
| --- | --- | --- |
| PENDING | DISPATCHED | envio aceito/incerto, ACK/RESULT durante envio, lease abandonado |
| PENDING | FAILED | indisponibilidade esgotada (`GATEWAY_UNAVAILABLE`), recusa permanente (`DISPATCH_REJECTED`), servidor desabilitado (`SERVER_DISABLED`) |
| DISPATCHED | ACKNOWLEDGED | ACK válido ou ACK inferido por RESULT |
| DISPATCHED | TIMEOUT | prazo total (`EXECUTION_TIMEOUT`) ou última janela de ACK (`ACK_TIMEOUT`) |
| ACKNOWLEDGED | SUCCEEDED / FAILED / TIMEOUT | RESULT válido ou prazo total |
| terminais | — | imutáveis nos serviços |

`FAILED` = falha explícita ou não-entrega **comprovada**. `TIMEOUT` = resultado
desconhecido depois de uma entrega possível. Não existe DISPATCHED → PENDING nem
DISPATCHED → FAILED por indisponibilidade.

**Reserva/lease/dispatch:** transação curta reserva a tentativa (`dispatchLeaseId`
UUID, lease de 2 s, `dispatchAttempts++`, `dispatchedConnectionId`, deadlines),
faz commit, chama `GameGateway.send` **sem transação nem lock** (timeout local de
1 s) e reconcilia numa segunda transação só se o `dispatchLeaseId` ainda for o
seu. Lease expirado é tratado como entrega possível (PENDING → DISPATCHED).

**Identificadores:**

| Campo | Origem | Estável nos retries? | Uso |
| --- | --- | --- | --- |
| `commandId` | UUID do backend (`game_commands.id`) | sim | chave de dedup obrigatória no Agent |
| `correlationId` | UUID novo por command, UNIQUE | sim | conferência cruzada em ACK/RESULT |
| `idempotencyKey` | chamador (HTTP `Idempotency-Key` ou interno) | sim | dedup de criação no backend; escopo por ator |
| `connectionId` | `game_connections.id` da tentativa | **não** (muda após reconexão) | hoje: exigido em ACK e RESULT; decidido para 11.2: exigido só no ACK, provenance no RESULT (§8.1) |
| `ackDeadlineAt` | por tentativa | **não** | janela de ACK |
| `executionDeadlineAt` | fixado na primeira reserva | sim | Agent não deve executar depois dele |

**Validação e limites:** payload validado e copiado por tipo antes de qualquer
await (`commandPayload`), teto de **4096 bytes**; result revalidado por tipo
(`commandResult`) contra o payload persistido (ex.: `characterId`, `targetId`,
nonce), teto de **65536 bytes** na aplicação e em CHECK PostgreSQL; JSON canônico
com profundidade máxima 32. Tipos desconhecidos → 400.

**Idempotência de resultado:** UNIQUE(`game_command_id`) em `game_command_results`;
RESULT idêntico (comparação canônica) é no-op; conflitante → 409 preservando o
original; RESULT em DISPATCHED infere ACK; RESULT após TIMEOUT → 409; deadline
vencido sem worker → o próprio receiver grava TIMEOUT.

**Servidor offline/stale/disabled:** sem sessão saudável o dispatcher nem chama
`send` e consome uma tentativa; disabled impede connect, heartbeat e novos
dispatches, e PENDING sem tentativa em voo termina `FAILED/SERVER_DISABLED`.

**Erros remotos aceitos hoje:** apenas `PING_REJECTED` (só BRIDGE_PING) e
`BRIDGE_ERROR`. `error_code` é `varchar(64)` **sem CHECK enumerado**: ampliar o
catálogo em 11.2 é mudança de código, não de schema.

**O que já está pronto para um transport real:** o contrato `GameGateway`, o
modelo de sessão (`connect/heartbeat/disconnect`), os envelopes e mensagens
ACK/RESULT, o receiver completo, lease/retry/timeout e a persistência antes do I/O.
**O que falta:** o adapter real do `GameGateway`, o socket, a autenticação, e
**qualquer chamador de produção do dispatcher**: hoje nenhum código fora dos testes
chama `dispatch`, `dispatchPending`, `retryTimedOutDispatches`, `expireCommands`
ou `markStaleConnections` (não há scheduler). Toda POST de Character, Moderation,
World ou query de Player termina PENDING para sempre em produção.

**Garantias existentes (inalteradas nesta etapa):**

1. O backend persiste o command (e o Audit, quando aplicável) **antes** de qualquer I/O.
2. A entrega é **at-least-once** com tentativas limitadas; não há exactly-once.
3. O Agent **deve** deduplicar por `serverId`/`commandId`, conferir
   `correlationId` e responder um re-envio com o resultado anterior.
4. Um resultado não executa efeitos duas vezes no backend (UNIQUE + comparação canônica).

### 2.2 Server Control (`src/server-control/`)

| Peça | Estado |
| --- | --- |
| `ServerControlGateway.send(request, signal)` | abstrato; `ServerControlRequest = { operationId, gameServerId, type, correlationId, requestedAt }` |
| `DisconnectedServerControlGateway` | provider de produção; sempre `UNAVAILABLE` |
| `ServerControlDispatcher` | claim por UPDATE autocommit (`dispatch_claimed_at`), `send` sem transação (1 s), resultado cercado por `status = PENDING` |
| Tipos | `SERVER_START`, `SERVER_PAUSE`, `SERVER_RESTART` (sem payload; sem `stop`, `execute` ou comando livre) |
| Estados | `PENDING`, `DISPATCHED`, `FAILED` (`AGENT_UNAVAILABLE`, `AGENT_REJECTED`, `SERVER_DISABLED`), `SUCCEEDED` (**inalcançável**) |

`SUCCEEDED` depende da integração porque não existe receptor de resultado: o
backend só sabe que entregou (ou que não conseguiu provar que não entregou).
Somente o Agent sabe se o processo iniciou/pausou/reiniciou.

| | GameCommand | Server Control |
| --- | --- | --- |
| Alvo | runtime do Skyrim (via SKSE) | supervisor do processo |
| Payload | JSON tipado por tipo | nenhum |
| Entrega | at-least-once, lease, retries, ACK | **at-most-once**: claim nunca é reenviado |
| Estados | 6, com ACK e TIMEOUT | 4, sem ACK/TIMEOUT |
| Dedup no Agent | obrigatória | obrigatória (defesa em profundidade) |

**Riscos de retry:** repetir RESTART às cegas é pior que exigir nova solicitação
explícita (reinício duplo, perda de sessões de jogadores). Por isso: operação com
claim e sem resultado (queda durante `send`) permanece `PENDING` com
`dispatch_claimed_at` preenchido, e `dispatchPending()` a ignora. Hoje não há
reconciliação: esse estado é final na prática. Server Control **permanece um
protocolo separado** de GameCommand; não será unificado.

### 2.3 Entry points que esperam o Agent (Agent → Backend)

Todos são serviços internos, sem rota HTTP, com ator `SYSTEM:AGENT`, e já
idempotentes. Nenhum deles tem transporte hoje.

| Domínio | Entry point atual | Input | Chave de idempotência | Transação | Retry esperado | Subetapa |
| --- | --- | --- | --- | --- | --- | --- |
| GameCommand ACK | `GameCommandReceiver.acknowledge` (`game-bridge/game-command-receiver.ts`) | `BridgeMessage` | `commandId` + `correlationId` + `connectionId` | 1 tx curta (lock server → command) | duplicado = no-op | 11.2 |
| GameCommand RESULT | `GameCommandReceiver.result` | `ResultMessage` | idem; UNIQUE(result) | 1 tx; result + status atômicos | idêntico = no-op; conflito 409 | 11.2 |
| Heartbeat/conexão | `GameConnectionService.connect/heartbeat/disconnect` | `gameServerId`, `externalConnectionId`, versões | `externalConnectionId` único por servidor | 1 tx por chamada | heartbeat periódico; connect com novo id a cada socket | 11.1 |
| Character ownership | `CharacterLinkService.confirmFromAgent` (`player-characters/character-link.service.ts`) | `{ challenge, gameServerId, characterExternalId }` | challenge single-use (hash); replay → `ALREADY_VERIFIED` | 1 tx: link → challenge → player; Audit junto | seguro | 11.4 |
| Profession XP | `ProfessionExperienceService.grantFromAgent` (`professions/profession-experience.service.ts`) | `{ gameServerId, characterExternalId, eventId, amount }` | UNIQUE(`game_server_id`, `external_event_id`) | 1 tx: lock da profissão; evento + XP + Audit | mesmo evento → `ALREADY_APPLIED`; outro conteúdo → `EVENT_CONFLICT` | 11.4 |
| Trade settlement | `TradeSettlementService.confirmFromAgent` (`player-trades/trade-settlement.service.ts`) | `{ tradeId, settlementEventId, outcome: SETTLED\|FAILED }` | UNIQUE(`game_server_id`, `settlement_event_id`) + UNIQUE(`trade_id`) | 1 tx: trade → escrow → ledger; Audit; realtime pós-commit | `LEDGER_REJECTED` não grava evento (retry permitido) | 11.4 |
| Marketplace custody | `MarketplaceCustodyService.confirmFromAgent` (`player-marketplace/marketplace-custody.service.ts`) | `{ listingId, custodyEventId, outcome: CUSTODIED\|FAILED }` | UNIQUE(`game_server_id`, `custody_event_id`) + UNIQUE(`listing_id`) | 1 tx: listing; Audit; realtime | idem | 11.4 |
| Marketplace settlement | `MarketplaceSettlementService.confirmFromAgent` (`player-marketplace/marketplace-settlement.service.ts`) | `{ purchaseId, settlementEventId, outcome: SETTLED\|FAILED }` | UNIQUE(`game_server_id`, `settlement_event_id`) + UNIQUE(`purchase_id`) | 1 tx: listing → purchase → escrow → ledger | `LEDGER_REJECTED` retryable | 11.4 |
| VIP delivery | `VipDeliveryService.requestDelivery` (`vip-entitlements/vip-delivery.service.ts`) | `entitlementId` | — (sem estado) | — | devolve sempre `UNAVAILABLE / AGENT_NOT_INTEGRATED` | 11.4 |
| Server Control result | **inexistente** | — | `operationId` + `correlationId` (proposto) | — | — | 11.3 |

Outros pontos encontrados na busca e **fora** do escopo de Agent → Backend:

- `EconomyLedgerService` aceita postings `SYSTEM_CREDIT/SYSTEM_DEBIT` com ator
  SYSTEM e o módulo diz "exported for … the future Agent transport". **Não há
  contrato** de sincronização de gold do Skyrim; o ledger é backend-owned.
  Qualquer "gold do jogo → ledger" é decisão de produto aberta (§23), não 11.4.
- `SystemSource` já contém `AGENT`, `PROFESSION` e `VIP_DELIVERY`, com CHECKs em
  `audit_logs`, `game_commands` e `economy_transactions`: VIP delivery pode submeter
  GameCommands como `SYSTEM:VIP_DELIVERY` **sem migration de ator**.
- Chat (`player-chat`), Guilds e Groups declaram explicitamente "sem integração
  Skyrim/Agent". Nada a integrar.
- Moderation `PLAYER_BAN` atua no runtime Skyrim (`playerId` opaco do jogo) e
  **não** altera `players.status`; continua assim.

**Lacuna encontrada — escopo por servidor:** os três serviços de Trade/Marketplace
recebem apenas `tradeId`/`listingId`/`purchaseId` e **não conferem** que a entidade
pertence ao GameServer do Agent. Hoje é seguro (não há transporte); em 11.4 é
obrigatório passar o `gameServerId` da sessão autenticada ao serviço e rejeitar
divergência **dentro da transação do domínio** (não no router, que não acessa
repositórios). Ownership e Profession já recebem `gameServerId` e o usam na busca.

## 3. Agent transport decision

### Requisitos derivados do código existente

1. `GameGateway.send` precisa **resolver em ≤ 1 s** para uma **sessão específica**
   (`GatewayConnection.id`) e não pode redirecionar para outra: exige um canal
   push já aberto e endereçável por sessão.
2. ACK/RESULT podem chegar **durante** o `send` (o dispatcher foi desenhado para
   isso): o canal é full-duplex.
3. `game_connections` modela exatamente uma sessão persistente: `connect` →
   heartbeats → `disconnect`/STALE/SUPERSEDED, com um CONNECTED por servidor.
4. O Agent roda em hosts de jogo, possivelmente atrás de NAT/firewall: o backend
   não deve abrir conexões para ele.
5. O Agent precisa enviar eventos de domínio e receber respostas tipadas
   (`APPLIED/ALREADY_APPLIED/REJECTED`) para decidir entregar ou liberar itens.
6. O projeto já usa `ws` (`src/realtime/realtime.gateway.ts`) e JSON; não há broker.

### Avaliação

| Critério | WebSocket persistente (Agent disca) | HTTP polling + callback | Combinação |
| --- | --- | --- | --- |
| NAT/firewall | ✔ saída do Agent | ✔ polling; ✘ callback exige backend → Agent | ✔ |
| `send` ≤ 1 s para uma sessão | ✔ frame no socket da sessão | ✘ `send` vira "enfileirado"; aceitação ≠ entrega, semântica do lease muda | parcial |
| Latência Backend → Agent | ms | intervalo de polling / long-poll | — |
| Heartbeat e sessão | nativos (1 socket = 1 `GameConnection`) | sintéticos (cada poll = heartbeat) | duplicados |
| ACK/RESULT durante send | ✔ | ✔ via POST | ✔ |
| Complexidade | 1 superfície nova | 2+ rotas, auth por request, long-poll | 2 superfícies para manter |
| Reuso do código | alto (padrão do `RealtimeGateway`) | médio | médio |

### Decisão

**WebSocket persistente, iniciado e autenticado pelo Agent, em superfície própria
(`/api/v1/agent`, proposta), transportando todas as mensagens nos dois sentidos.**
Sem HTTP callback e sem HTTP polling na 11.1.

Trade-offs aceitos:

- **Instância única.** O socket vive num processo; o worker que chama
  `GameGateway.send` precisa estar no mesmo processo. É a mesma restrição do
  `RealtimeEventBus` atual ("single instance only … Etapa 12"). Multi-instância
  (roteamento por servidor, sticky, broker) fica para a Etapa 12.
- **Reconexão é responsabilidade do Agent** (backoff exponencial com jitter).
- **Backpressure:** o adapter deve recusar `send` (`TRANSIENT`) se o buffer do
  socket exceder um limite, em vez de acumular.

Condição técnica para 11.1: o `RealtimeGateway` atual registra um handler de
`upgrade` que **responde 400 e destrói** qualquer socket cujo path não seja
`/api/v1/realtime`. Uma segunda superfície WS exige um roteador de upgrade único
(ou que cada handler ignore paths que não são seus). Os dois `WebSocketServer`
continuam separados, com limites próprios.

### Topologia final do Agent (decidida)

```text
Backend
    ↕  TLS / WebSocket  (/api/v1/agent, credencial do GameServer)
Host Agent             (processo no host, um por GameServer)
    ↕  transporte / IPC local  (fora deste repositório)
SKSE Plugin
    ↕
Skyrim
```

**Host Agent**

- Processo separado do Skyrim.
- **É a única identidade autenticada** perante o Backend (credencial do §4).
- Permanece vivo e conectado quando o Skyrim está STOPPED.
- Supervisiona o processo do jogo: executa START/PAUSE/RESTART de Server Control
  (e um futuro STOP, se criado).
- Encaminha operações de gameplay tipadas à integração local com o SKSE.
- Recebe resultados e eventos locais e os envia ao Backend.
- Mantém o journal de execução/deduplicação (§8.2) e o conhecimento das operações
  de Server Control (§9).

**SKSE Plugin**

- **Não** autentica no Backend e **não** mantém a conexão remota principal.
- Executa apenas operações tipadas de gameplay recebidas do Host Agent.
- Pode desaparecer e reconectar localmente sempre que o Skyrim reinicia.

O transporte local Host Agent ↔ SKSE (named pipe, socket local, etc.) **não é
definido aqui**: Agent e SKSE não estão neste repositório. O Backend só assume o
contrato: o Host Agent reporta ao Backend se a ponte local está pronta (§3.1).

Consequência para o modelo atual: `game_connections` passa a representar a
**sessão do Host Agent**, não "o plugin respondendo". A presença ONLINE/STALE/
OFFLINE do Admin descreve conectividade do Agent, não disponibilidade do jogo.

### 3.1 Agent connected ≠ game ready

São dois estados independentes:

| Estado | Significa | Fonte |
| --- | --- | --- |
| **A) Conectividade do Host Agent** | existe sessão autenticada e saudável (heartbeat) | `game_connections` (CONNECTED + heartbeat) |
| **B) Prontidão do runtime** | processo Skyrim rodando **e** ponte SKSE conectada/pronta **e** capability compatível | reportado pelo Host Agent no HELLO e em todo HEARTBEAT (e numa mensagem de mudança de estado, se definida) |

Um Agent pode estar CONNECTED com o Skyrim parado, iniciando, pausado ou com o
SKSE ainda não conectado. **"Agent conectado" nunca é sinônimo de "Skyrim
disponível".**

| Fluxo | Pré-requisito para envio |
| --- | --- |
| Server Control | somente (A) + capability do tipo (`SERVER_START` precisa funcionar com o jogo parado) |
| GameCommand | (A) **e** (B) **e** o `type` presente nas capabilities de gameplay atuais |
| Domain events (Agent → Backend) | (A); o evento já ocorreu no jogo |
| `WORK_SYNC` / `WORK_ITEMS` | (A); o Agent decide executar só quando (B) |

O HELLO/HEARTBEAT deve informar, **conceitualmente** (enum final na 11.1):

- sessão/conectividade do Agent (`connectionId`, `agentInstanceId`);
- `agentVersion`;
- capabilities (Server Control, tipos de gameplay, eventos);
- estado do processo do jogo (ex.: parado, iniciando, rodando, pausado, parando);
- prontidão da ponte SKSE (ex.: desconectada, conectando, pronta).

GameCommands aceitos enquanto o runtime não está pronto **continuam a semântica
atual**: são persistidos PENDING, mantêm TTL/tentativas/deadlines como hoje e
**não são enviados** até existir runtime elegível. Na 11.2 o gateway responde
`UNAVAILABLE` (não-entrega comprovada) sem escrever no socket quando (B) não é
verdadeiro ou o tipo não está nas capabilities; com isso vale o caminho existente
PENDING → FAILED `GATEWAY_UNAVAILABLE` ao esgotar tentativas, sem inferir
execução. Se isso gastar tentativas rápido demais durante um restart do jogo, a
11.2 pode fazer o worker não reservar tentativas enquanto (B) é falso — mudança de
política do worker, não do lifecycle.

## 4. Authentication model

Identidade própria do Agent. **Nunca** Staff JWT, Player JWT, `staff_sessions`,
`player_sessions`, `JWT_*_SECRET` ou `PLAYER_JWT_*_SECRET`.

### Credencial (proposta para 11.1)

| Campo | Regra |
| --- | --- |
| `credentialId` | UUID público, identifica a credencial (lookup sem varrer hashes) |
| `gameServerId` | FK para `game_servers`; uma credencial pertence a **um** servidor |
| segredo | 256 bits de `crypto.randomBytes`, codificado base64url, exibido **uma vez** na emissão |
| `secret_hash` | SHA-256 hex do segredo (mesmo padrão de `player_sessions.refresh_token_hash` e do challenge); comparação com `timingSafeEqual`. Segredo aleatório de alta entropia dispensa KDF lenta; argon2 (já dependência) só se o segredo puder ser escolhido por humanos, o que não deve ocorrer |
| `created_at`, `created_by_staff_id` | autoria |
| `last_used_at` | atualizado no HELLO |
| `revoked_at`, `revoked_by_staff_id` | revogação imediata |
| `expires_at` | opcional |

- **Rotação:** até **duas** credenciais ativas por servidor (antiga e nova), para
  trocar sem downtime; depois revoga-se a antiga.
- **Revogação:** fecha imediatamente a conexão ativa autenticada por ela (close
  `CREDENTIAL_REVOKED`) e rejeita novos HELLO.
- **Emissão/revogação:** por Staff. Precisa de permission dedicada (proposta:
  `GAME_AGENT_CREDENTIAL_MANAGE`) com Audit; o catálogo atual de permissions não a
  contém. Endpoint Admin ou comando CLI (como `staff:bootstrap`) é decisão aberta.
- Plaintext nunca é persistido, logado, auditado nem retornado depois da emissão.

### Migration provável em 11.1

- Tabela `game_agent_credentials` (campos acima; índices por servidor e ativos).
- `game_connections.credential_id` (FK) para saber qual credencial abriu a sessão
  e fechá-la na revogação.
- Possivelmente `game_connections.capabilities` (jsonb) e `agent_version`
  (hoje existe `bridge_version varchar(64)`, reutilizável).
- Se houver endpoint Admin: permission + grants (COORDINATOR, DEV) e AuditActions.

### Handshake (proposto)

O segredo trafega **no primeiro frame**, nunca na URL (mesma regra do realtime).

```json
{
  "protocolVersion": "1",
  "type": "HELLO",
  "messageId": "0f0e…",
  "occurredAt": "2026-10-01T12:00:00.000Z",
  "payload": {
    "gameServerId": "019b4700-3333-4333-8333-333333333333",
    "credentialId": "019b4700-5555-4555-8555-555555555555",
    "secret": "<base64url>",
    "agentInstanceId": "c8b4…",
    "agentVersion": "1.4.2",
    "supportedProtocolVersions": ["1"],
    "capabilities": {
      "commandTypes": ["BRIDGE_PING", "CHARACTER_PROFILE_QUERY"],
      "domainEvents": ["CHARACTER_OWNERSHIP_CONFIRMATION"],
      "serverControl": ["SERVER_START", "SERVER_RESTART"]
    },
    "runtime": { "process": "RUNNING", "gameBridge": "READY" }
  }
}
```

(Os valores de `runtime` são ilustrativos; o enum final é fixado na 11.1, §3.1.)

Resposta `WELCOME` com `connectionId` (= `game_connections.id`), versão negociada,
`heartbeatIntervalMs`, timeout e limites (frame, in-flight). `agentInstanceId` é o
`externalConnectionId`: **novo a cada socket** (o serviço atual rejeita reuso de
um id encerrado). Qualquer falha → `ERROR` genérico + close, sem revelar se o
servidor ou a credencial existem.

## 5. Protocol / envelope

`PROTOCOL_VERSION = "1"` já existe e já é persistido em
`game_connections.protocol_version`. A versão do socket do Agent **é** esse "1": o
envelope externo é novo, mas os contratos internos já publicados (`CommandEnvelope`,
`BridgeMessage`, `ResultMessage`) viajam **inalterados** dentro de `payload`.

```json
{
  "protocolVersion": "1",
  "type": "COMMAND",
  "messageId": "UUID do frame",
  "gameServerId": "UUID",
  "occurredAt": "ISO-8601 UTC",
  "inReplyTo": "messageId opcional (respostas)",
  "payload": { }
}
```

- Adaptação ao projeto: `CommandEnvelope` usa `serverId`, não `gameServerId`. O
  envelope externo usa `gameServerId`; o interno mantém `serverId`. Ambos devem
  coincidir com o servidor **da sessão autenticada**; divergência → `ERROR
  SERVER_MISMATCH` e close.
- `messageId` identifica o **frame** (log, correlação `inReplyTo`, dedup de
  transporte). **Não** é chave de domínio: GameCommand usa `commandId`, eventos
  usam `eventId`, Server Control usa `operationId`.
- Chaves extras no envelope ou no payload → rejeição (mesma regra "closed" de
  `actor()` e dos DTOs).
- Frames binários → protocol error. Tamanho máximo de frame proposto: **128 KiB**
  (cabe um result de 64 KiB mais envelope; o realtime usa 16 KiB).
- Compatibilidade: campos novos só em versão nova. O backend aceita a lista
  `supportedProtocolVersions` do HELLO e escolhe a maior comum; se não houver,
  `ERROR PROTOCOL_UNSUPPORTED` e close. Versões antigas são removidas só com
  janela de depreciação documentada.

## 6. Message types

| Tipo | Direção | Payload | Resposta | Subetapa |
| --- | --- | --- | --- | --- |
| `HELLO` | A → B | credencial, versões, capabilities, runtime | `WELCOME` ou `ERROR`+close | 11.1 |
| `WELCOME` | B → A | `connectionId`, limites, intervalos | — | 11.1 |
| `HEARTBEAT` | A → B | `connectionId`, estado do processo, prontidão SKSE, capabilities de gameplay atuais | `HEARTBEAT_ACK` | 11.1 |
| `HEARTBEAT_ACK` | B → A | `serverTime` | — | 11.1 |
| `GOODBYE` | A → B ou B → A | motivo | close | 11.1 |
| `COMMAND` | B → A | `CommandEnvelope` (inalterado) | `COMMAND_ACK` e depois `COMMAND_RESULT` | 11.2 |
| `COMMAND_ACK` | A → B | `BridgeMessage` | — | 11.2 |
| `COMMAND_RESULT` | A → B | `ResultMessage` | `ERROR` só se rejeitado | 11.2 |
| `SERVER_CONTROL` | B → A | `ServerControlRequest` + `notAfter` (proposto) | `SERVER_CONTROL_ACK` | 11.3 |
| `SERVER_CONTROL_ACK` | A → B | `operationId`, `correlationId` | — | 11.3 |
| `SERVER_CONTROL_RESULT` | A → B | `operationId`, `correlationId`, `outcome`, `errorCode?` | — | 11.3 |
| `DOMAIN_EVENT` | A → B | `{ eventType, eventId, data }` | `DOMAIN_EVENT_RESULT` | 11.4 |
| `DOMAIN_EVENT_RESULT` | B → A | resultado tipado do serviço (`APPLIED`, `ALREADY_APPLIED`, `REJECTED` + reason) | — | 11.4 |
| `WORK_SYNC` | A → B | escopo opcional (ex.: `characterExternalId`) | `WORK_ITEMS` | 11.4 |
| `WORK_ITEMS` | B → A | lista de trabalho pendente derivada do banco (§13–15) | — | 11.4 |
| `ERROR` | ambos | `code`, `inReplyTo?`, `retryable` | — | 11.1 |

`ERROR.code` é catálogo fechado (ex.: `INVALID_MESSAGE`, `UNAUTHORIZED`,
`PROTOCOL_UNSUPPORTED`, `SERVER_MISMATCH`, `UNKNOWN_COMMAND`, `RESULT_CONFLICT`,
`STALE_CONNECTION`, `TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED`); nunca stack trace,
SQL ou texto de exceção.

**Proibido em qualquer versão:** tipo de mensagem ou command que carregue console
Skyrim bruto, Papyrus arbitrário, shell, script, SQL, caminho de arquivo ou
operação de filesystem. O catálogo é fechado no backend (`COMMAND_TYPES`,
`SERVER_CONTROL_TYPES`, eventos do router) e o Agent deve recusar qualquer tipo
fora do seu próprio allowlist.

## 7. Delivery guarantees

As quatro garantias são **distintas** e não devem ser misturadas.

**GameCommand — at-least-once**
- Persistido antes do I/O; retries limitados (`GAME_COMMAND_MAX_DISPATCH_ATTEMPTS`)
  com os mesmos `commandId`/`correlationId`.
- `commandId` é a identidade primária de execução; o Agent **obrigatoriamente**
  mantém um journal durável de execução/resultado (§8.2), que sobrevive a
  reconexão e restart, e nunca repete o side effect de um `commandId` já visto.
- RESULT pertence ao **command**, não à conexão: pode ser reenviado por uma sessão
  sucessora do mesmo GameServer (§8.1, 11.2).
- Result idempotente no backend (UNIQUE + comparação canônica).
- Para commands mutáveis, retry só é seguro onde o Agent prova a deduplicação;
  execução anterior não comprovável vira `UNCERTAIN`, nunca reexecução.

**Server Control — at-most-once operacional**
- `operationId` identifica a operação. Uma operação com claim nunca é reenviada
  pelo backend; reconexão não autoriza reexecução.
- `SERVER_CONTROL_RESULT` é ligado a `gameServerId` da sessão + `operationId`, não
  à conexão antiga: pode chegar por uma sessão sucessora (§9).
- Incerteza (exceção/timeout no send, queda com claim) **não** vira retry: vira
  estado explícito de desfecho desconhecido (11.3) e exige nova solicitação humana
  com nova `Idempotency-Key`.
- Agent deduplica por `operationId` mesmo assim e recusa operação vencida
  (`notAfter`), para que um frame atrasado não reinicie o servidor minutos depois.

**Domain events — at-least-once com dedup no backend**
- O Agent gera `eventId` **persistente** (gravado antes de enviar) e reenvia até
  receber `DOMAIN_EVENT_RESULT`.
- O backend deduplica **por domínio** com as chaves já existentes (§2.3); não há
  tabela genérica de inbox, porque cada domínio já grava o evento na mesma
  transação do efeito.
- `REJECTED` é resposta definitiva para aquele `eventId`, exceto
  `LEDGER_REJECTED` e `TEMPORARILY_UNAVAILABLE`, que são retryable.

**Realtime Player/Staff — best effort**
- Publicado após o commit, in-process, sem outbox. Cliente que perde evento relê via
  HTTP. HTTP/banco continuam fonte de verdade. Nada do Agent depende de realtime.

## 8. GameCommand flow

```text
Staff/Player HTTP ──► ActorCommandService.create ──► GameCommandBus.submitInTransaction
                         (policy + Audit na mesma tx)         │ commit (PENDING)
                                                             ▼
                               11.2: worker in-process ──► GameCommandDispatcher.dispatch
                                                             │ reserve (tx) → commit
                                                             ▼
                                   AgentGameGateway.send ──► frame COMMAND no socket da sessão
                                                             │
Agent: dedup(commandId) ── COMMAND_ACK ──► Router ──► GameCommandReceiver.acknowledge
Agent: executa (≤ executionDeadlineAt)
Agent: grava resultado ─── COMMAND_RESULT ─► Router ──► GameCommandReceiver.result (tx)
```

A 11.2 adiciona o **worker** (hoje inexistente): dispatch logo após o commit do
request (como `ServerControlService` já faz com `dispatchSafely`), mais varreduras
periódicas de `dispatchPending`, `retryTimedOutDispatches` e `expireCommands`.
`markStaleConnections` é periódica desde a 11.1.

### 8.1 ACK vs RESULT (decidido; implementação na 11.2)

**COMMAND_ACK é relativo à tentativa de entrega.** Confirma que *aquela*
tentativa chegou ao Agent. Continua validando `gameServerId` da sessão,
`commandId`, `correlationId` e o `connectionId` da tentativa (comportamento atual).
ACK de uma sessão que não é a da tentativa é descartado (não é erro de protocolo
grave; é informação obsoleta).

**COMMAND_RESULT é relativo ao command, não à conexão WebSocket.** Validação
obrigatória:

- `commandId` existente;
- `correlationId` igual ao persistido;
- `gameServerId` do command = `gameServerId` da **sessão autenticada** que envia
  (e = `serverId` do payload);
- a sessão que envia está ativa e saudável (é a sessão atual daquele servidor);
- contrato de result por tipo (`commandResult`, limite de 64 KiB) ou `errorCode`
  do catálogo.

O RESULT **não** é rejeitado só porque chegou por uma conexão diferente da que
enviou o command. O `connectionId` recebido é guardado como provenance/
observabilidade (ex.: sessão que entregou o resultado), não como requisito de
validade. Isso muda o `match` atual do receiver, que hoje exige
`dispatchedConnectionId === connectionId` também no RESULT; a mudança é da 11.2.

Cenário que **precisa** funcionar na 11.2:

1. Backend envia command C pela conexão A.
2. Agent executa e grava o resultado no journal.
3. A conexão A cai antes do RESULT.
4. Agent reconecta como conexão B (nova sessão, mesmo GameServer).
5. Agent reenvia o RESULT de C por B.
6. Backend aceita: mesmo GameServer, command/result válidos, sem resultado
   conflitante. DISPATCHED infere ACK; ACKNOWLEDGED conclui.

Sem isso, um command ACKNOWLEDGED executado terminaria TIMEOUT, porque
ACKNOWLEDGED nunca é reenviado.

| Caso | Resposta |
| --- | --- |
| mesmo RESULT de novo (qualquer sessão válida do servidor) | idempotente: devolve o estado atual, sem INSERT (atual) |
| RESULT conflitante para command finalizado | rejeitado `RESULT_CONFLICT`; original preservado (atual) |
| RESULT de outro GameServer | rejeitado `SERVER_MISMATCH`; sessão encerrada (tentativa de injeção) |
| `commandId` desconhecido | rejeitado `UNKNOWN_COMMAND`, logado com ids |
| malformed (envelope, contrato, tamanho) | rejeitado `INVALID_MESSAGE`; reincidência fecha a sessão |
| RESULT antes de qualquer tentativa possível (PENDING sem lease/tentativa) | rejeitado (atual) |
| RESULT tardio válido | finaliza o command enquanto a policy permitir: antes de `executionDeadlineAt` e sem TIMEOUT persistido. Depois disso, TIMEOUT vence (atual) e o RESULT é rejeitado como conflito, com métrica de "resultado após TIMEOUT" |

### 8.2 Deduplicação ponta a ponta e crash recovery (requisito do Agent)

At-least-once só é seguro com deduplicação **no executor**. Requisitos que o
protocolo e o backend assumem e exigem do Host Agent:

- **`commandId` é a identidade primária de execução.** `correlationId` continua
  sendo correlação e conferência; **não** substitui `commandId` como chave.
- O Agent mantém um **journal durável** de execução/resultado por
  `(gameServerId, commandId)`, suficiente para: receber o mesmo `commandId` de
  novo, **não** repetir o side effect e reenviar o resultado conhecido.
- Reconexão de WebSocket e restart do Agent **não** limpam o journal.
- O journal registra a intenção **antes** de encaminhar ao SKSE (ex.: `RECEIVED`
  → `FORWARDED` → `COMPLETED(result)`), para que um restart saiba se a operação
  pode ter sido executada.

**Crash window:** o Agent encaminha a operação ao SKSE, o Skyrim executa o
efeito, e o Agent cai antes de persistir ou receber o resultado. Nesse caso é
**proibido** reexecutar um command mutável sem saber se o efeito anterior ocorreu.

A 11.2 distingue estas situações quando o Agent recebe um `commandId` de novo:

| Situação no journal | Ação do Agent | Estado no backend |
| --- | --- | --- |
| desconhecido (nunca recebido) | executa | fluxo normal |
| `COMPLETED` | **safe replay**: reenvia o resultado guardado, sem executar | SUCCEEDED/FAILED |
| `FORWARDED` sem resultado, e o SKSE consegue responder pelo `commandId` | resultado recuperável: obtém e reenvia | SUCCEEDED/FAILED |
| `FORWARDED` sem resultado e sem como provar | não executa; reporta **UNCERTAIN** | terminal TIMEOUT com `errorCode = EXECUTION_UNCERTAIN` |

UNCERTAIN reutiliza o estado terminal que já significa "resultado final
desconhecido após possível entrega" (TIMEOUT); o código diferencia a origem.
`error_code` não tem CHECK enumerado e `outcome` TIMEOUT já existe, então não há
migration. **UNCERTAIN nunca é FAILED**, porque FAILED significa "não executou".

- Queries (sem side effect) podem ser reexecutadas pelo Agent em qualquer caso.
- Para commands mutáveis, a 11.2 **não** considera retry automaticamente seguro
  se o Agent não declarar (capability) que mantém esse journal; sem ela, o
  backend não envia tipos mutáveis àquele Agent.
- Não se enfraquece silenciosamente at-least-once para "executa de novo".

### Backend → Agent: catálogo atual (32 tipos, fechado)

Quem origina: **S** = Staff (RBAC), **P** = Player (ownership VERIFIED),
**Sys** = interno.

| Domínio | Tipo | Payload | Result | Q/A | Origem | Retry seguro? |
| --- | --- | --- | --- | --- | --- | --- |
| Bridge | `BRIDGE_PING` | `{ nonce }` | `{ nonce }` (igual) | Q | Sys | sim |
| Character | `CHARACTER_INVENTORY_QUERY` | `{ characterId }` | `{ characterId, items[{itemId, quantity, displayName?}] }` | Q | S | sim |
| Character | `CHARACTER_PROPERTIES_QUERY` | `{ characterId }` | `{ characterId, properties[{propertyId, displayName?}] }` | Q | S, P | sim |
| Character | `CHARACTER_HOLDS_QUERY` | `{ characterId }` | `{ characterId, holds[…] }` | Q | S, P | sim |
| Character | `CHARACTER_HORSES_QUERY` | `{ characterId }` | `{ characterId, horses[…] }` | Q | S, P | sim |
| Character | `CHARACTER_FACTIONS_QUERY` | `{ characterId }` | `{ characterId, factions[…] }` | Q | S | sim |
| Character | `CHARACTER_INVENTORY_REMOVE_ITEM` | `{ characterId, itemId, quantity }` | `{ characterId, applied: true, targetId }` | A | S | **só com dedup** (não idempotente no jogo) |
| Character | `CHARACTER_ITEM_GIVE` | `{ characterId, itemId, quantity }` | mutation result | A | S (futuro Sys:VIP) | **só com dedup** |
| Character | `CHARACTER_PROPERTY_GRANT` / `_REVOKE` | `{ characterId, propertyId }` | mutation result | A | S | sim por natureza (estado alvo) + dedup |
| Character | `CHARACTER_HOLD_GRANT` / `_REVOKE` | `{ characterId, holdId }` | mutation result | A | S | idem |
| Character | `CHARACTER_HORSE_GIVE` | `{ characterId, horseId }` | mutation result | A | S (futuro Sys:VIP) | **só com dedup** |
| Character | `CHARACTER_HORSE_REVOKE` | `{ characterId, horseId }` | mutation result | A | S | idem estado alvo |
| Character | `CHARACTER_TITLE_GIVE` | `{ characterId, titleId }` | mutation result | A | S (futuro Sys:VIP) | estado alvo + dedup |
| Character | `CHARACTER_SPELL_GIVE` | `{ characterId, spellId }` | mutation result | A | S (futuro Sys:VIP) | estado alvo + dedup |
| Character | `CHARACTER_FACTION_ADD` / `_REMOVE` | `{ characterId, factionId }` | mutation result | A | S | estado alvo + dedup |
| Profile | `CHARACTER_PROFILE_QUERY` | `{ characterId }` | `{ characterId, name, level, race, sex, health, magicka, stamina }` | Q | P | sim |
| Profile | `CHARACTER_SKILLS_QUERY` | `{ characterId }` | `{ characterId, skills{18} }` | Q | P | sim |
| Moderation | `PLAYER_BAN` / `PLAYER_UNBAN` | `{ playerId, reason? }` | `{ playerId, banned }` | A | S | estado alvo + dedup |
| Moderation | `PLAYER_GOD_MODE_SET` | `{ playerId, enabled }` | eco do payload | A | S | estado alvo |
| Moderation | `STAFF_NOCLIP_SET` / `STAFF_INVISIBILITY_SET` | `{ actorStaffId, enabled }` | eco | A | S | estado alvo |
| Moderation | `ANNOUNCEMENT_SEND` | `{ message }` | `{ sent: true }` | A | S | **só com dedup** (duplicaria anúncio) |
| Moderation | `STAFF_TELEPORT_TO_PLAYER` / `PLAYER_TELEPORT_TO_STAFF` | `{ actorStaffId, targetPlayerId }` | `{ …, teleported: true }` | A | S | com dedup (repetir move de novo) |
| World | `WORLD_STATE_QUERY` | `{}` | `{ gameHour, weatherId }` | Q | S | sim |
| World | `WORLD_TIME_SET` | `{ gameHour }` | `{ gameHour }` | A | S | estado alvo |
| World | `WORLD_WEATHER_SET` | `{ weatherId }` | `{ weatherId }` | A | S | estado alvo |
| World | `WORLD_ENTITY_SPAWN` | `{ actorStaffId, baseFormId, quantity }` | `{ actorStaffId, baseFormId, requestedQuantity, spawnedQuantity }` | A | S | **só com dedup** |

Totais: 1 + 17 (5 queries, 12 mutations) + 2 + 8 + 4 = **32**. Players originam
exatamente os 5 da allowlist `PLAYER_CHARACTER_QUERY_TYPES` (profile, skills,
properties, holds, horses), todos queries. Nenhum command é originado pelo Agent.

## 9. ServerControl flow (11.3)

```text
Staff POST /control/{start|pause|restart} ─► ServerControlService (op + Audit, tx) ─► commit
   └─► dispatchSafely: claim (UPDATE autocommit) ─► AgentServerControlGateway.send
          ├─ recusado comprovadamente (sem sessão, capability ausente) ─► FAILED
          ├─ aceito/ambíguo ─► DISPATCHED
Agent: dedup(operationId), confere notAfter ─► SERVER_CONTROL_ACK ─► (proposto) ACKNOWLEDGED
Agent: executa ação supervisionada ─► SERVER_CONTROL_RESULT ─► SUCCEEDED | FAILED
```

Server Control só exige o Host Agent conectado e a capability do tipo (§3.1);
não depende do runtime do Skyrim.

**Após reconexão (decidido; implementação na 11.3):**

- `operationId` identifica a operação; a execução continua **at-most-once**.
- O Host Agent guarda de forma durável o conhecimento de cada `operationId`
  recebido (recebida, em execução, concluída com resultado) e **nunca** a executa
  de novo por causa de um reenvio, reconexão ou restart.
- Uma reconexão pode **reenviar o `SERVER_CONTROL_RESULT`** da mesma operação.
  O resultado é válido se ligado a `gameServerId` da sessão autenticada +
  `operationId` (+ `correlationId`), e não é rejeitado por vir de uma sessão
  diferente da que recebeu a operação.
- Reconexão **não** autoriza o backend a reenviar START/PAUSE/RESTART, nem o Agent
  a reexecutá-los. Resultado duplicado idêntico é no-op; conflitante é rejeitado.
- Se o Agent não souber o desfecho (caiu durante a ação), reporta desfecho
  desconhecido; o operador decide com base no estado de runtime reportado.

Propostas para 11.3 (exigem migration no CHECK de status/timestamps de
`server_control_operations`):

- Estado de desfecho desconhecido (nome a decidir: `TIMEOUT` ou `OUTCOME_UNKNOWN`),
  alcançado por deadline de resultado ou pela reconciliação de claims sem resultado.
  Nunca reenvia; apenas encerra e informa o operador.
- `ACKNOWLEDGED` opcional, se o Agent enviar ACK.
- Catálogo fechado de erros remotos (ex.: `ALREADY_RUNNING`, `NOT_RUNNING`,
  `START_FAILED`, `EXPIRED`), no mesmo formato de `SERVER_CONTROL_ERRORS`.
- `notAfter` no request (ex.: `requestedAt` + 60 s) para o Agent recusar entregas
  tardias.
- Conflitos por estado de processo reportado e política de uma operação em voo
  por servidor.

## 10. Domain event routing

```text
AgentTransport (ws: upgrade, frame size, binário, rate, estado AUTH)
      │  frames JSON válidos
      ▼
AgentSession (credencial → gameServerId, connectionId, capabilities)
      │  identidade autenticada, nunca vinda do payload
      ▼
AgentMessageRouter
      │  valida envelope + versão + type; valida gameServerId do envelope = sessão;
      │  despacha por type para um adapter; aplica limites de in-flight
      ▼
typed adapters (um por type)
      │  valida/copia payload (allowlist), converte para o contrato interno,
      │  injeta gameServerId DA SESSÃO, mapeia retorno → DOMAIN_EVENT_RESULT
      ▼
domain services existentes (confirmFromAgent, grantFromAgent, receiver…)
```

| `eventType` (proposto) | Adapter → serviço | Retorno |
| --- | --- | --- |
| `CHARACTER_OWNERSHIP_CONFIRMATION` | `CharacterLinkService.confirmFromAgent` | `OwnershipConfirmation` (sem `playerId` no fio: o Agent não precisa saber o dono) |
| `PROFESSION_EXPERIENCE` | `ProfessionExperienceService.grantFromAgent` | `ExperienceGrant` |
| `TRADE_SETTLEMENT` | `TradeSettlementService.confirmFromAgent` (+ `gameServerId`, 11.4) | `SettlementResult` (sem `ledgerReason` no fio) |
| `MARKETPLACE_CUSTODY` | `MarketplaceCustodyService.confirmFromAgent` (+ `gameServerId`) | `CustodyResult` |
| `MARKETPLACE_SETTLEMENT` | `MarketplaceSettlementService.confirmFromAgent` (+ `gameServerId`) | `MarketSettlementResult` |
| `MARKETPLACE_CUSTODY_RELEASED` | **novo em 11.4** (devolução ao seller após cancel/falha) | a definir |
| `VIP_DELIVERY_*` | resultado via GameCommand (§15) | — |

Regras do router:

- **Sem regra de negócio**: não decide XP, ownership, escrow ou status.
- **Não importa repositórios nem `DataSource`** de domínio; só serviços. Proposta:
  teste unitário que falha se `src/agent-*` importar `typeorm`/entities de domínio,
  no mesmo estilo do teste que já proíbe `child_process` em `server-control`.
- Exceção do serviço (ex.: banco indisponível) → `ERROR TEMPORARILY_UNAVAILABLE`
  retryable; nunca `APPLIED` presumido.
- Nenhum log de payload, challenge, segredo ou resultado (regra já vigente no Game
  Bridge); só ids, type, outcome e reason.

### 10.1 Work recovery: `WORK_SYNC` / `WORK_ITEMS` (proposta mantida, 11.4)

Intenção e limites:

- **Recovery/sincronização** depois de HELLO e de toda reconexão: o Agent pede, o
  backend devolve o trabalho pendente daquele GameServer.
- **Live push pode coexistir**: após o commit de uma transição (trade AWAITING,
  listing PENDING_CUSTODY, purchase AWAITING, listing cancelada com custódia), o
  backend pode enviar o mesmo `WORK_ITEMS` como dica. Perder o push não perde
  trabalho, porque o próximo `WORK_SYNC` o recalcula.
- **Estritamente tipado**: catálogo fechado de `kind` (`TRADE_CUSTODY`,
  `LISTING_CUSTODY`, `PURCHASE_SETTLEMENT`, `LISTING_RELEASE`, e VIP se aplicável),
  cada um com payload allowlisted (ids, character ids, item ids opacos,
  quantidades). **Não é comando arbitrário** nem canal de execução genérico.
- **O backend continua autoridade do estado**: os itens são derivados das tabelas
  de domínio no momento do pedido, sem estado próprio; nada muda no backend por
  causa de um `WORK_ITEMS` enviado.
- **Os retornos continuam deduplicados pelos event ids de domínio**
  (`settlementEventId`, `custodyEventId`, …). Receber o mesmo trabalho duas vezes
  não gera efeito duplicado: o Agent consulta seu journal e, se já respondeu,
  reenvia o mesmo evento, que resulta em `ALREADY_APPLIED`.

## 11. Character verification

```text
Player (Electron) POST /player/character-links { gameServerId, characterExternalId }
   ◄── 201 { link PENDING, challenge "ABCD-EFGH-JKLMN", expiresAt }   (hash SHA-256 no banco)
Player digita o challenge no jogo (comando/diálogo do mod)
SKSE → Agent: { challenge, characterExternalId do personagem logado }
Agent ─ DOMAIN_EVENT CHARACTER_OWNERSHIP_CONFIRMATION { eventId, challenge, characterExternalId } ─► Router
Router injeta gameServerId da sessão ─► CharacterLinkService.confirmFromAgent
   ◄── VERIFIED | ALREADY_VERIFIED | REJECTED(reason)
Agent informa o jogador in-game; Electron relê GET /player/character-links/:linkId
```

- O Agent reporta **somente** `challenge` e o `characterExternalId` do personagem
  realmente logado, obtido do runtime (nunca digitado pelo jogador). `gameServerId`
  vem da sessão; um Agent não consegue verificar characters de outro servidor.
- Preservado: hash SHA-256 (o plaintext só existe na resposta 201 e no frame do
  Agent), TTL (`PLAYER_LINK_CHALLENGE_TTL`), single-use (`consumed_at`), revogação
  de challenges anteriores, `characterExternalId` escopado por servidor, reuso de
  challenge consumido → `ALREADY_VERIFIED` só para o mesmo link.
- `eventId` aqui serve só a transporte/log: a idempotência real é o challenge.
- O Agent não deve logar nem persistir o challenge além do necessário para o
  reenvio; tentativas repetidas de challenges inválidos por um mesmo character
  devem ser limitadas no Agent (brute force de 64 bits é inviável, mas spam não).
- Não há evento realtime de link verificado hoje (§16).

## 12. Professions

```text
Agent observa ação de gameplay ─► gera eventId durável ─► DOMAIN_EVENT PROFESSION_EXPERIENCE
   { eventId, characterExternalId, amount }  (gameServerId da sessão)
Router ─► ProfessionExperienceService.grantFromAgent ─► GRANTED | ALREADY_APPLIED | REJECTED
```

- **Identidade:** `(gameServerId, eventId)`, com `eventId` único por servidor
  gerado pelo Agent (UUID recomendado; o validador aceita `externalId`).
- **Retry:** reenviar o mesmo `eventId` e `amount` até receber resposta; replay →
  `ALREADY_APPLIED`. Mudar `amount` com o mesmo id → `EVENT_CONFLICT`.
- **Rejeições não persistem o evento** (`PROFESSION_NOT_SELECTED`,
  `PLAYER_UNAVAILABLE`, `INVALID_INPUT`). Consequência: se o Agent reenviar o mesmo
  id depois que o jogador escolher a profissão, o XP seria aplicado
  retroativamente. Contrato: **`REJECTED` é final para o `eventId`**; o Agent só
  reenvia quando não obteve resposta.
- **Validação:** `amount` inteiro 1–1.000.000 (`MAX_EXPERIENCE_GRANT`); a regra de
  nível e o teto de XP ficam no serviço; o transport não recalcula nada.
- **Ownership:** a profissão pertence ao character identity; dono atual suspenso ou
  banido bloqueia; sem dono atual, o XP ainda acumula (regra 10.7, inalterada).
- **Quais ações geram XP** e em que quantidade é decisão de produto aberta (§23).

## 13. Trade

Estado atual: o segundo accept reserva o GOLD em `TRADE_ESCROW`; com GAME_ITEM o
trade para em `AWAITING_GAME_CONFIRMATION` e publica o realtime
`TRADE_AWAITING_GAME_CONFIRMATION` **só para players**. **O Agent não é avisado**:
não existe mensagem Backend → Agent para iniciar a custódia.

Sequência proposta (11.4):

```text
Backend: trade → AWAITING (GOLD RESERVED)            [commit]
Backend ─ WORK_ITEMS { kind: TRADE_CUSTODY, tradeId, parties, items } ─► Agent
          (push após commit + WORK_SYNC em todo (re)connect; §10.1)
Agent: jogadores online? valida itens e quantidades, retira os itens para
       custódia durável e reversível (journal local persistido)
Agent ─ DOMAIN_EVENT TRADE_SETTLEMENT { eventId, tradeId, outcome: SETTLED } ─► Backend
Backend (tx): settle GOLD, COMPLETED, evento gravado, Audit    ─► APPLIED
Agent: entrega os itens às contrapartes (retry durável até concluir)

falha de custódia ou impossibilidade ─► outcome FAILED ─► GOLD RELEASED, trade FAILED
                                         Agent devolve itens eventualmente retirados
LEDGER_REJECTED ─► nada muda; Agent mantém custódia, reenvia depois com o
                   MESMO eventId, ou envia FAILED com outro eventId
```

- **Invariante:** nenhum item é entregue irreversivelmente antes do `APPLIED` de
  `SETTLED`. GOLD commit do backend é a autoridade da conclusão econômica.
- **Crash recovery:** o Agent persiste `(tradeId, eventId, fase)` antes de cada
  passo. Resposta perdida → reenvio → `ALREADY_APPLIED` com o status final,
  e o Agent segue para a entrega ou devolução. Backend reinicia → o trade continua
  AWAITING no banco e reaparece no próximo `WORK_SYNC`.
- **Lacuna de escopo:** passar e conferir `gameServerId` da sessão (§2.3).
- **Lacuna de produto:** trade AWAITING não expira e o Player não pode cancelar.
  Se o Agent nunca responder, o GOLD fica reservado indefinidamente. Decidir em
  11.4: timeout operacional com `FAILED` iniciado pelo backend **somente** se o
  Agent confirmar que não tem custódia, ou ação de operador.

## 14. Marketplace

Estado atual: create → `PENDING_CUSTODY`; custody → `ACTIVE`; purchase →
`RESERVED` + purchase `AWAITING_GAME_CONFIRMATION` + escrow; settlement →
`SOLD`/`FAILED`; cancel de `PENDING_CUSTODY`/`ACTIVE` → `CANCELLED`. **O Agent não
é avisado de nenhuma dessas transições.**

Sequência proposta (11.4):

```text
1. Listing custody
   Backend: PENDING_CUSTODY ─ WORK_ITEMS { kind: LISTING_CUSTODY, listingId, seller, item, qty } ─► Agent
   Agent: seller online, retira item para custódia durável
   Agent ─ MARKETPLACE_CUSTODY { eventId, listingId, CUSTODIED | FAILED } ─► ACTIVE | FAILED
   LISTING_NOT_PENDING (ex.: cancelada no meio) ─► Agent devolve o item ao seller

2. Purchase settlement
   Backend: purchase AWAITING (GOLD em MARKET_ESCROW)
          ─ WORK_ITEMS { kind: PURCHASE_SETTLEMENT, purchaseId, listingId, buyer } ─► Agent
   Agent: item continua sob sua custódia ─ MARKETPLACE_SETTLEMENT { eventId, purchaseId, SETTLED } ─►
   Backend (tx): paga o seller, purchase COMPLETED, listing SOLD ─► APPLIED
   Agent: entrega ao buyer (retry durável)
   FAILED ─► refund do buyer, listing FAILED ─► Agent devolve ao seller

3. Refund/release
   Listing CANCELLED ou FAILED com custody_event_id preenchido
          ─ WORK_ITEMS { kind: LISTING_RELEASE, listingId } ─► Agent devolve ao seller
   Agent ─ MARKETPLACE_CUSTODY_RELEASED { eventId, listingId } ─► Backend registra devolução
```

- **Invariante:** item só sai da custódia para o buyer depois do `APPLIED` de
  `SETTLED`; para o seller, depois de `CANCELLED`/`FAILED` confirmados no backend.
- **Lacuna de estado:** hoje não há registro de "item devolvido ao seller". Sem
  ele, uma listing CANCELLED/FAILED com custódia continuaria aparecendo em todo
  `WORK_SYNC`. Proposta 11.4: tabela append-only de release events (ou colunas
  `custody_released_at`/`custody_release_event_id`) — **migration**.
- **Crash recovery:** igual a Trade; `WORK_SYNC` é recalculado a partir das tabelas
  de domínio (listings/purchases/escrows), que já são a fonte de verdade — não é
  necessária uma outbox para esses trabalhos.
- **Lacuna de escopo:** conferir `gameServerId` da sessão nos dois serviços.

## 15. VIP delivery

Estado atual: `VipDeliveryService.requestDelivery` sempre retorna
`UNAVAILABLE/AGENT_NOT_INTEGRATED`; não há estado de entrega. Os rewards
(`VipReward`) já são exatamente os payloads de `CHARACTER_ITEM_GIVE`,
`CHARACTER_HORSE_GIVE`, `CHARACTER_TITLE_GIVE` e `CHARACTER_SPELL_GIVE` sem
`characterId`, e `SystemSource.VIP_DELIVERY` já é aceito pelos CHECKs.

Recomendação para 11.4:

```text
entitlement ACTIVE (CHARACTER scope)
   → vip_reward_deliveries: 1 linha por (entitlementId, rewardIndex), status PENDING
   → GameCommand tipado CHARACTER_*_GIVE, ator SYSTEM:VIP_DELIVERY,
     idempotencyKey = "vip:<entitlementId>:<rewardIndex>" (determinística)
   → Agent executa com dedup por commandId
   → COMMAND_RESULT SUCCEEDED → delivery DELIVERED (mesma tx do receiver ou reação após commit)
     FAILED                  → delivery FAILED (retentável com nova tentativa explícita)
     TIMEOUT                 → delivery UNCERTAIN (operador decide; nunca reenvia sozinho)
```

- **Migration necessária:** tabela `vip_reward_deliveries` (entitlement FK,
  `reward_index`, snapshot do reward, `game_command_id`, status
  `PENDING|IN_FLIGHT|DELIVERED|FAILED|UNCERTAIN`, timestamps, UNIQUE por
  entitlement + índice + tentativa).
- **Nunca** marcar DELIVERED antes de `COMMAND_RESULT SUCCEEDED` validado.
- `TIMEOUT` de um `*_GIVE` pode ter sido executado: repetir com outro command
  duplicaria o item. Por isso UNCERTAIN + ação de operador.
- Reward não idempotente (ITEM) vs estado alvo (TITLE/SPELL/HORSE): retry
  automático após `FAILED` explícito é seguro para todos, porque FAILED significa
  "não executou".
- **Scope PLAYER** não tem character alvo: decisão aberta (entregar no character
  escolhido pelo player? em todos? só benefícios de conta?).
- Revoke/expiração **não** removem rewards já entregues (não há comando de
  remoção para VIP). Decisão de produto.
- Continua sem checkout/pagamento.

## 16. Electron HTTP/realtime matrix

Todas as rotas abaixo existem (prefixo `/api/v1`, `PlayerAuthGuard` exceto o
catálogo público e a troca de auth).

| Feature | HTTP | Realtime | Fonte de verdade | Launcher IPC? | Agent? |
| --- | --- | --- | --- | --- | --- |
| Auth | `POST player/auth/discord/exchange`, `POST player/auth/refresh`, `POST player/auth/logout`, `GET player/me` | — (socket fecha em `TOKEN_EXPIRED`) | backend (`player_sessions`) | não (OAuth/PKCE/state no Electron) | não |
| Characters | `POST player/character-links`, `GET player/character-links/:linkId`, `POST player/character-links/:linkId/revoke`, `GET player/me/characters[/:characterLinkId]` | **nenhum** | backend; verificação pelo Agent | não | **sim** (ownership) |
| Profile / Skills | `POST player/game-servers/:gameServerId/characters/:characterId/{profile,skills}-query`, `GET player/character-operations/:operationId` | **nenhum** (polling) | Skyrim via GameCommand | não | **sim** |
| Properties / Holds / Horses | `POST …/{properties,holds,horses}-query`, `GET player/character-operations/:operationId` | **nenhum** (polling) | Skyrim via GameCommand | não | **sim** |
| Professions | `GET` / `POST player/me/characters/:characterLinkId/profession` | nenhum | backend; XP do Agent | não | **sim** (XP) |
| Groups | `POST player/groups`, `GET :groupId`, invites/leave/kick/disband, `GET/POST player/group-invites…` | `GROUP_*` (8) | backend | não | não |
| Guilds | `POST player/guilds`, `GET :guildId`, invites/leave/kick/role/transfer-master/disband, `player/guild-invites…`, `GET player/me/characters/:id/guild` | `GUILD_*` (11) | backend | não | não |
| Wallet | `GET player/me/characters/:characterLinkId/wallet`, `GET …/wallet/transactions` | nenhum próprio (mudanças chegam via `TRADE_*`/`MARKETPLACE_*`; reler) | backend ledger | não | não |
| Trade | `POST player/trades`, `GET :tradeId`, `PUT :tradeId/offer`, `POST :tradeId/{accept,cancel}`, `GET player/me/characters/:id/trades` | `TRADE_*` (7) | backend; GAME_ITEM pelo Agent | não | **sim** (itens) |
| Marketplace | `POST/GET player/marketplace/listings`, `GET :listingId`, `POST :listingId/{purchase,cancel}`, `GET player/me/characters/:id/marketplace/{listings,purchases}` | `MARKETPLACE_*` (6) | backend; custódia/settlement pelo Agent | não | **sim** |
| Chat | `POST player/chat/global`, `POST player/chat/direct/:targetCharacterId`, `POST/GET player/{groups,guilds}/:id/chat`, `GET player/me/characters/:id/chat/{global,direct/:target}` | `CHAT_MESSAGE_CREATED` | backend | não | não |
| Settings | `GET` / `PATCH player/settings` | `PLAYER_SETTINGS_UPDATED` | backend (preferências de conta) | não (config local do cliente fica local) | não |
| VIP | `GET vip-store/offers[/:code]` (público), `GET player/vip/entitlements`, `GET player/me/characters/:id/vip/{entitlements,effective}` | `VIP_ENTITLEMENT_{GRANTED,REVOKED}` | backend; entrega pelo Agent | não | **sim** (entrega) |
| Jogo local | — | — | máquina do jogador | **sim** | não |

Conclusão: todas as telas de Groups, Guilds, Wallet, Chat, Settings, catálogo VIP e
leitura de Trade/Marketplace já podem consumir o backend diretamente hoje. Telas
que dependem do runtime (ownership, profile/skills, properties/holds/horses,
settlement de itens, entrega VIP) têm API pronta, mas só produzem resultado com o
Agent real.

Gaps reais para 11.5 (documentados, **não** implementados):

1. **Descoberta de servidores pelo Player:** `POST player/character-links` exige
   `gameServerId`, mas a única listagem de servidores é Admin
   (`GET game-servers`, `GAME_BRIDGE_READ`). O Electron não tem como obter o id
   sem configuração externa. Precisa de uma leitura pública/Player mínima
   (`id`, `code`, `name`, disponibilidade) — decisão de 11.5.
2. **Sem realtime para link VERIFIED e para conclusão de character operations:**
   o Electron precisa fazer polling. Avaliar eventos `CHARACTER_LINK_VERIFIED` e
   `CHARACTER_OPERATION_COMPLETED` em 11.5/11.6 (evento, não endpoint).
3. Confirmar suporte do Discord a PKCE (`codeVerifier`) na integração real
   (pendência da 10.3).

## 17. Local Launcher boundary

O código do Electron e do Launcher C# **não está neste repositório**; 11.0 (e
11.5) só definem o contrato esperado, sem validar implementação.

Responsabilidades **locais** (Electron ↔ Launcher via IPC local, fora do backend):
verificar instalação do Skyrim, paths, updates, download de mods/arquivos e
progresso, integridade, load order, perfil local, launch do jogo e estado do
processo local.

Regras:

- O backend não recebe nem serve caminhos, load order, arquivos locais ou comandos
  de processo; não há rota para manipular filesystem local.
- O Launcher não chama Admin API e não precisa de credencial do backend; se no
  futuro precisar de manifestos de mods, será uma leitura pública/Player definida
  explicitamente, não um canal de controle.
- Player Settings guarda somente preferências de conta; configurações locais do
  cliente nunca entram nela (regra da 10.16).
- Tokens do Player ficam no Electron (armazenamento seguro do SO); o Launcher não
  precisa deles para funções locais.

## 18. Admin Web boundary

APIs existentes que o Admin Web já pode consumir (Staff JWT + RBAC):

| Área | Rotas |
| --- | --- |
| Auth | `POST auth/{login,refresh,logout}`, `GET auth/me` |
| Staff | `GET/POST staff`, `GET/PATCH staff/:id`, `PATCH staff/:id/{role,status}` |
| Audit | `GET audit`, `GET audit/:id` |
| Dashboard / Bridge | `GET dashboard`, `GET game-servers`, `GET game-servers/:id`, `GET game-servers/:id/{connections,commands}`, `GET game-commands/:id` (presença ONLINE/STALE/OFFLINE derivada de heartbeat) |
| Character Management | 17 POSTs em `game-servers/:serverId/characters/:characterId/...`, `GET character-operations/:commandId` |
| Moderation | 8 POSTs em `game-servers/:serverId/moderation/...`, `GET moderation-operations/:commandId` |
| World | 4 POSTs em `game-servers/:serverId/world/...`, `GET world-operations/:commandId` |
| VIP Store | `GET/POST admin/vip-store/offers`, `GET/PATCH admin/vip-store/offers/:id`, `PATCH …/:id/active` |
| Server Control | `POST game-servers/:serverId/control/{start,pause,restart}`, `GET server-control-operations/:operationId` |
| Realtime | surface `STAFF` autentica, mas **nenhum evento é entregue a staff** hoje |

Sem Agent real, todas as operações de runtime aceitam e persistem (202) mas nunca
concluem. Não existem, e 11.0 não cria: telas/rotas Admin para players, character
links, trades, marketplace, economia, grant/revoke HTTP de VIP entitlements e
credenciais do Agent. A de credenciais é necessária para operar 11.1 (ou CLI); as
demais são decisões de produto. Admin Web e Electron continuam sem acoplamento.

## 19. Realtime boundaries

| Superfície | Path | Auth | Direção | Fonte de verdade |
| --- | --- | --- | --- | --- |
| Player realtime | `/api/v1/realtime`, `surface: PLAYER` | Player access JWT no frame AUTH | só servidor → cliente (cliente só envia AUTH) | não; HTTP é |
| Staff realtime | `/api/v1/realtime`, `surface: STAFF` | Staff access JWT no frame AUTH | só servidor → cliente; hoje sem eventos | não |
| Agent transport | `/api/v1/agent` (proposto) | credencial do Agent no HELLO | **bidirecional**, request/response | participa de fluxos de estado |

Por que o Agent **não** reutiliza `/api/v1/realtime`:

- O realtime fecha o socket em qualquer frame após AUTH (`PROTOCOL_ERROR`): é
  push-only por desenho. O Agent precisa enviar ACK/RESULT/eventos.
- Auth por JWT de usuário com expiração curta e close em `TOKEN_EXPIRED`; o Agent
  precisa de credencial de máquina de longa duração, revogável por servidor.
- Frame máximo de 16 KiB; results chegam a 64 KiB.
- Realtime é best effort e sem estado; o socket do Agent está no caminho de
  lifecycle (sessão `game_connections`, heartbeat, lease).
- Misturar surfaces aumentaria o risco de cruzamento de privilégio (um bug de
  surface daria a um player capacidade de "falar como Agent").

## 20. Failure matrix

| Caso | Autoridade do estado | Retry esperado | Seguro automaticamente? | Ação do operador |
| --- | --- | --- | --- | --- |
| Agent offline | banco | dispatcher consome tentativas; PENDING → FAILED `GATEWAY_UNAVAILABLE`; Server Control → FAILED `AGENT_UNAVAILABLE`; eventos esperam no Agent | sim | reconectar o Agent; reenviar operações humanas |
| Agent conectado, Skyrim parado ou SKSE não pronto | banco + runtime reportado | GameCommand não é enviado (`UNAVAILABLE`, sem escrita no socket); segue TTL/tentativas atuais; Server Control funciona | sim | iniciar o jogo (START) se desejado |
| Agent reconnect | banco (`game_connections`) | novo `connect` com novo `agentInstanceId`; sessão anterior SUPERSEDED; `WORK_SYNC`; RESULTs pendentes reenviados pela nova sessão; **reconexão não implica replay de side effect** | sim | nenhuma |
| Conexão duplicada (mesmo servidor) | banco (índice parcial único) | a mais nova vence; a antiga recebe close `SUPERSEDED` e suas mensagens são rejeitadas | sim | investigar se não for reconexão legítima (credencial vazada?) |
| Backend restart | banco | sockets caem; Agent reconecta; leases expiram → DISPATCHED conservador; workers retomam | sim (GameCommand); Server Control com claim fica desconhecido | revisar Server Control desconhecido |
| Agent restart | journal durável do Agent | Agent reconecta, reenvia eventos sem resposta, responde re-envios de command pelo journal (safe replay) | sim **se** o journal é durável | se o journal se perdeu: reconciliar manualmente |
| Mensagem duplicada (frame) | chaves de domínio | — | sim (no-op) | nenhuma |
| ACK de tentativa antiga (outra sessão) | banco | descartado; ACK é attempt-bound | sim | nenhuma |
| Result duplicado | `game_command_results` UNIQUE | idêntico → no-op (em qualquer sessão válida do servidor); diferente → `RESULT_CONFLICT`, original preservado | sim | investigar conflito (bug do Agent) |
| Result de outro GameServer | sessão autenticada | rejeitado `SERVER_MISMATCH`, sessão encerrada | sim | investigar credencial/Agent |
| Evento duplicado | tabelas de evento por domínio | `ALREADY_APPLIED` / `ALREADY_VERIFIED` | sim | nenhuma |
| Payload malformado | — | `ERROR INVALID_MESSAGE`; reincidência → close | sim | corrigir Agent |
| Protocol mismatch | — | `PROTOCOL_UNSUPPORTED` + close; sem retry até atualizar | sim | atualizar Agent/backend |
| Credencial revogada | banco (credenciais) | close; HELLO rejeitado; sem retry com a mesma | sim | emitir nova credencial |
| Banco indisponível | — | HELLO/eventos → `TEMPORARILY_UNAVAILABLE` retryable; dispatcher não reserva | sim (retry com backoff) | restaurar banco |
| Dispatch committed, socket morre antes do send | banco (lease) | lease expira → DISPATCHED; retry na nova sessão com os mesmos ids | sim (Agent dedup) | nenhuma |
| Agent executa, result se perde (conexão cai) | journal do Agent + banco | Agent reconecta e reenvia o RESULT pela nova sessão; aceito por ser do mesmo GameServer e do mesmo command (§8.1, 11.2). Hoje o receiver ainda o rejeitaria; a 11.2 fecha isso | sim após 11.2 | nenhuma |
| Agent encaminha ao SKSE e cai antes de saber o resultado (command mutável) | journal (`FORWARDED` sem resultado) | **não reexecuta**; recupera o resultado pelo SKSE se possível, senão reporta UNCERTAIN → TIMEOUT `EXECUTION_UNCERTAIN` | sim (sem duplicar efeito) | verificar no jogo e corrigir manualmente |
| Backend commita result e a conexão cai antes de responder | banco | Agent reenvia o mesmo result por qualquer sessão válida → no-op idêntico | sim após 11.2 | nenhuma |
| Server Control: send ambíguo ou reconexão | banco + conhecimento durável do Agent | **nunca** reenviado nem reexecutado automaticamente; RESULT da mesma operação pode chegar pela nova sessão | — (at-most-once) | verificar o servidor; nova solicitação se necessário |
| Result tardio após TIMEOUT | banco (TIMEOUT imutável) | 409 conflito | não reabre | **efeito pode ter ocorrido**: métrica + reconciliação manual |

## 21. Security model

| Ameaça | Defesa esperada (11.1+) |
| --- | --- |
| Agent impersonation | credencial por servidor, hash SHA-256, comparação constant-time, TLS no deployment; erros genéricos |
| Replay de mensagens | chaves de domínio idempotentes; `correlationId` em ACK/RESULT, `connectionId` da tentativa no ACK, `gameServerId` da sessão no RESULT; `executionDeadlineAt`/`notAfter`; HELLO só no estado inicial do socket |
| Injeção cross-server | `gameServerId` **sempre** da sessão; envelope/`serverId` divergente → close; serviços de Trade/Marketplace passam a conferir servidor (§2.3) |
| Execução arbitrária | catálogo fechado de tipos no backend e no Agent; nenhum campo de console/Papyrus/shell/script/SQL/path; payloads validados por allowlist |
| Eventos forjados | só sessões autenticadas chegam ao router; eventos validados por tipo; o Agent é confiável **apenas para o seu servidor** |
| Credencial roubada | revogação imediata com close da sessão; rotação com 2 ativas; `last_used_at`; alerta em conexão duplicada inesperada; nunca em URL/log |
| Payload grande | `maxPayload` do WS (128 KiB proposto); limites de 4096/65536 bytes já existentes; profundidade 32 |
| Flood de mensagens | limite de frames por segundo e de in-flight por sessão; close `RATE_LIMITED`; HELLO com timeout (como `REALTIME_AUTH_TIMEOUT_MS`) |
| Protocolo malformado | parser estrito (chaves exatas, sem binário); N erros → close |
| Cruzamento Player/Staff/Agent | três superfícies e três modelos de credencial sem reuso; ator `SYSTEM:AGENT` nunca vem do fio; router não chama serviços de Player/Staff; players só originam as 5 queries |

Sem criptografia customizada: TLS terminado no proxy/ingress; o backend recebe
`wss://` já decifrado. mTLS pode ser adicionado no proxy como defesa extra, sem
mudar o protocolo.

## 22. Observability

Logs estruturados (sem payload, segredo, challenge ou result), com
`gameServerId`, `connectionId`, `messageId`, `type` e ids de domínio:

| Sinal | Tipo | Origem |
| --- | --- | --- |
| Agent conectado/desconectado (motivo: REQUESTED, STALE, SUPERSEDED, REVOKED, PROTOCOL) | evento + gauge por servidor | `game_connections` / transport |
| Contagem de reconexões | counter | transport |
| Auth rejeitada (motivo interno) | counter | handshake |
| Latência de dispatch (created → DISPATCHED) | histograma | `game_commands` timestamps |
| Latência de result (DISPATCHED → terminal) | histograma | receiver |
| Commands PENDING/DISPATCHED/ACKNOWLEDGED acima de X s | gauge / alerta | query periódica |
| TIMEOUT e result tardio após TIMEOUT | counter | receiver |
| Mensagens malformadas / `RESULT_CONFLICT` | counter | router |
| Eventos de domínio: APPLIED / ALREADY_APPLIED / REJECTED por reason | counter | adapters |
| `LEDGER_REJECTED` | counter + warn (já logado hoje) | Trade/Marketplace |
| Server Control desconhecido (claim sem resultado, deadline) | counter + alerta | 11.3 |
| Trabalhos pendentes (trades AWAITING, listings PENDING_CUSTODY, purchases AWAITING, VIP UNCERTAIN) | gauge | query |

Stack de métricas (Prometheus/OpenTelemetry) não é adicionada na Etapa 11; os
sinais podem começar como logs estruturados e consultas ao banco.

## 23. Open decisions

| Decisão | Quando |
| --- | --- |
| Emissão de credenciais: endpoint Admin + permission nova, ou CLI | 11.1 |
| Enum final de estado do processo e de prontidão SKSE; persistir capabilities/runtime em `game_connections` ou só em memória | 11.1 |
| Catálogo tipado de erros remotos por domínio (sem migration: `error_code` sem CHECK) | 11.2 |
| Worker deixa de consumir tentativas enquanto o runtime não está pronto, ou mantém a política atual | 11.2 |
| Nome e semântica do estado "desfecho desconhecido" de Server Control; ACK; `notAfter` | 11.3 |
| Política de concorrência de Server Control por servidor e regras pelo estado de processo reportado | 11.3 |
| Catálogo final de `kind` de `WORK_ITEMS` e se a entrega VIP também passa por ele ou só por GameCommands | 11.4 |
| Registro de devolução de custódia do Marketplace (migration) | 11.4 |
| Expiração/resolução de trades e purchases AWAITING sem resposta do Agent | 11.4 |
| `vip_reward_deliveries`; alvo de entitlements PLAYER; efeito de revoke em rewards entregues | 11.4 |
| Quais ações de gameplay geram XP e quanto | produto / 11.4 |
| Sincronização de gold do jogo com o ledger (hoje: não existe) | produto |
| Descoberta de servidores pelo Player; eventos realtime de link verificado e operação concluída | 11.5 |
| Multi-instância do backend (roteamento de sockets, broker) | Etapa 12 |

## 24. Mapping para 11.1–11.6

A divisão proposta foi **confirmada**, com o escopo abaixo. Nenhuma subetapa nova.

| Subetapa | Escopo | Migration provável |
| --- | --- | --- |
| **11.0** Integration Discovery + Contracts | este documento | não |
| **11.1** Game Agent Transport + Authentication | roteador de upgrade; `WebSocketServer` do Agent; credenciais (hash, rotação, revogação); HELLO/WELCOME/HEARTBEAT/GOODBYE/ERROR; ligação com `GameConnectionService` (sessão do Host Agent); estado de runtime/SKSE no HELLO/HEARTBEAT; `markStaleConnections` periódica; limites e rate; `AgentMessageRouter` vazio com testes de fronteira; `BRIDGE_PING` ponta a ponta opcional | sim (`game_agent_credentials`, `game_connections.credential_id`, talvez capabilities; permission se houver endpoint) |
| **11.2** GameCommand Execution + Results | `AgentGameGateway` substituindo `DisconnectedGameGateway`; worker de dispatch pós-commit e varreduras; COMMAND/ACK/RESULT; gate por prontidão de runtime + capability; erros tipados; RESULT independente da sessão (§8.1); journal/UNCERTAIN (§8.2) | provavelmente não |
| **11.3** Server Control Real Transport | `AgentServerControlGateway`; ACK/RESULT; estado desconhecido; reconciliação de claims; `notAfter`; RESULT por `gameServerId` + `operationId` após reconexão; conflitos por estado de processo | sim (CHECK de status/timestamps) |
| **11.4** Agent Domain Events + Gameplay Delivery | adapters de ownership, profession, trade, marketplace; `gameServerId` nos serviços de Trade/Marketplace; `WORK_SYNC`; release de custódia; VIP delivery | sim (release de custódia, `vip_reward_deliveries`) |
| **11.5** Electron / Launcher Integration Contract | matriz §16 validada contra o cliente real; descoberta de servidores; eventos realtime de link/operação; contrato local Launcher documentado | talvez não |
| **11.6** End-to-End Realtime + Integration Validation | Agent de teste (fake no repo) cobrindo a failure matrix; realtime ponta a ponta; observabilidade mínima; revisão de segurança | não |

11.4 é a mais extensa; se crescer demais, a divisão natural é "eventos de
confirmação" (ownership, XP) antes de "custódia e entrega" (trade, marketplace,
VIP), mantendo a numeração.
