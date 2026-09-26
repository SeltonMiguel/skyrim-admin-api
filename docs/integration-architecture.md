# Etapa 11 — Integration Architecture (11.0)

Documento de discovery e contratos. **Não há código, migration, endpoint ou
transporte nesta subetapa.** Ele inventaria o que as Etapas 00–10 deixaram pronto
para integração, fixa as decisões de transporte, autenticação, protocolo e
garantias de entrega do Game Agent, e distribui o trabalho restante entre as
subetapas 11.1–11.6.

**Estado:** 11.1 (transporte + autenticação do Host Agent, §4), 11.2 (execução de
GameCommand + resultados, §8.3) e 11.3 (Server Control pelo Host Agent,
at-most-once, §9.1) e 11.4 (eventos de domínio do Agent + trabalho de gameplay,
§10.2) e 11.5 (contrato Electron/Launcher e gaps backend, §16) estão implementadas.
11.6 (realtime Staff, recuperação de cold start e bateria final) fecha a Etapa 11:
ver §25 e `docs/admin-web-integration.md`.
Implementações dos clientes externos e trabalho posterior continuam propostos.

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

**Lacuna encontrada — escopo por servidor (corrigida na 11.4):** os três serviços de Trade/Marketplace
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

- **Socket numa instância.** O socket vive num processo; o worker que chama
  `GameGateway.send` precisa estar no mesmo processo. Desde a 12.5 isso é
  regra de ownership no banco (`owner_instance_id`): só a réplica dona envia
  e aceita frames; HTTP pode chegar a qualquer réplica e o banco é a fila.
  Sem sticky routing nem broker (`docs/multi-instance.md`).
- **Reconexão é responsabilidade do Agent** (backoff exponencial com jitter).
- **Backpressure:** o adapter deve recusar `send` (`TRANSIENT`) se o buffer do
  socket exceder um limite, em vez de acumular.

Condição técnica, **resolvida na 11.1**: o `RealtimeGateway` tinha o próprio
handler de `upgrade`, que respondia 400 a qualquer outro path. Agora
`WebSocketUpgradeRouter` (`src/websocket/`) é o **único** listener de `upgrade`:
`/api/v1/realtime` → realtime, `/api/v1/agent` → Agent, qualquer outro path ou
qualquer query string → 400. Os dois `WebSocketServer` continuam separados, com
limites próprios.

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

O HELLO/HEARTBEAT informa (fechado na 11.1, §4.4):

- sessão/conectividade do Agent (`connectionId`);
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

**Implementado na 11.1** (`src/game-agent/`, migration
`1790020000000-GameAgentTransport`). O que segue é o contrato em vigor.

### 4.1 Credencial

Tabela `game_agent_credentials`:

| Coluna | Regra |
| --- | --- |
| `id` | UUID; é o `credentialId` público |
| `game_server_id` | FK `game_servers`; a credencial pertence a **um** servidor |
| `secret_hash` | `char(64)`, CHECK `^[0-9a-f]{64}$`: SHA-256 hex do segredo |
| `status` | `ACTIVE` \| `REVOKED`, CHECK coerente com `revoked_at` |
| `created_by_staff_id` | FK `staff_users`, nullable |
| `created_at`, `last_used_at`, `revoked_at` | `last_used_at` só muda após HELLO autenticado |

- **Segredo:** 32 bytes de `crypto.randomBytes` (256 bits), base64url sem padding
  (43 caracteres), gerado pelo backend. Só o SHA-256 é persistido. SHA-256 é
  deliberado: o segredo é aleatório de alta entropia, não senha humana (mesmo
  raciocínio do refresh token de player); não há KDF lenta.
- **Comparação:** busca **por `credentialId`**, nunca pelo segredo; digests de
  tamanho fixo comparados com `timingSafeEqual`. Credencial inexistente também
  compara contra um digest fixo, para que os dois caminhos façam o mesmo trabalho.
- **Imutabilidade (trigger `guard_game_agent_credential`):** `id`, servidor, hash,
  autor e `created_at` nunca mudam; `status` só `ACTIVE → REVOKED`, uma vez;
  `DELETE` recusado (histórico). Não há `expires_at` nem `revoked_by_staff_id`: o
  Audit registra quem revogou.
- O segredo nunca é logado, auditado, devolvido depois da criação nem aparece em
  frames do backend. O hash nunca sai pela API.

### 4.2 Staff API

Permission nova **`GAME_AGENT_CREDENTIAL_MANAGE`**, concedida só a COORDINATOR e
DEV (37 permissions, 95 grants). GENERAL_CHIEF, ADMIN, MODERATOR e SUPPORT → 403.
Todas as respostas têm `Cache-Control: no-store`.

| Rota | Resposta |
| --- | --- |
| `GET /api/v1/admin/game-servers/:gameServerId/agent-credentials` | `{ items: [{ credentialId, gameServerId, status, createdAt, lastUsedAt, revokedAt }] }` |
| `POST /api/v1/admin/game-servers/:gameServerId/agent-credentials` | 201 `{ credentialId, gameServerId, credentialSecret, status: ACTIVE, createdAt }` — **única** vez que o segredo aparece |
| `POST /api/v1/admin/game-servers/:gameServerId/agent-credentials/:credentialId/revoke` | 200 com a metadata segura |

- Prefixo `admin/` como no catálogo VIP administrativo. Corpo vazio (qualquer
  propriedade → 400); servidor inexistente → 404; credencial de outro servidor →
  404.
- **Máximo de 2 ACTIVE** por servidor, para rotação sem downtime: A ativa → criar
  B → trocar o Agent → revogar A. Terceira → 409. A garantia é o lock `FOR UPDATE`
  da linha de `game_servers` na mesma transação da contagem e do INSERT (sem
  mutex em memória). Ordem de locks em create, revoke e HELLO: `game_servers →
  game_agent_credentials → game_connections`.
- **Create não é idempotente** por design: cada chamada emite um segredo novo,
  limitado pelo teto de 2. Resposta perdida → revogar e criar outra.
- **Revoke:** `ACTIVE → REVOKED`; repetir devolve o mesmo estado, sem Audit. Na
  mesma transação, as sessões `CONNECTED` daquela credencial viram `DISCONNECTED /
  CREDENTIAL_REVOKED`; logo após o commit, o socket é fechado (`4009`), sem esperar
  heartbeat. Outras credenciais do servidor não são afetadas.
- **Audit** (mesma transação da mutação; falha → 503 e rollback):
  `GAME_AGENT_CREDENTIAL_CREATED` (201) e `GAME_AGENT_CREDENTIAL_REVOKED` (200),
  `resourceType = GAME_AGENT_CREDENTIAL`, `resourceId = credentialId`, ator STAFF.
  Metadata `{ gameServerId, status }`. O `credentialId` fica em `resourceId`: o
  sanitizer do Audit remove por desenho qualquer chave que contenha "credential",
  e ele não foi afrouxado.
- Staff/Player JWT não autenticam o Agent, e o segredo do Agent não autentica
  nenhuma rota HTTP (Staff ou Player) nem o realtime.

### 4.3 HELLO e AUTHENTICATED

O segredo trafega **só no primeiro frame**, nunca na URL (o roteador de upgrade
recusa qualquer query string).

```json
{
  "protocolVersion": "1",
  "type": "HELLO",
  "messageId": "UUID",
  "gameServerId": "UUID",
  "occurredAt": "2026-10-01T12:00:00.000Z",
  "payload": {
    "credentialId": "UUID",
    "credentialSecret": "<43 caracteres base64url>",
    "agentVersion": "1.4.2",
    "capabilities": ["BRIDGE_PING", "SERVER_START"],
    "gameProcessState": "STOPPED",
    "skseReady": false
  }
}
```

Validação estrita (chaves exatas, extras → erro): UUIDs, `occurredAt` ISO-8601
UTC, segredo com o formato exato (um JWT nunca passa), `agentVersion`
`[A-Za-z0-9._:-]{1,64}`, até 64 capabilities distintas `^[A-Z][A-Z0-9_]{0,63}$`,
`gameProcessState` do enum e `skseReady` booleano. Capabilities expressam
compatibilidade operacional; **não concedem autorização**.

Verificação e ativação, em duas fases:

1. **Transação** (nada é publicado em memória): servidor existe → credencial
   existe → pertence ao `gameServerId` do HELLO → ACTIVE → segredo confere →
   servidor habilitado → cria a sessão (`game_connections`, fechando a anterior
   como `SUPERSEDED`) → atualiza `last_used_at` → **commit**. Qualquer falha ou
   rollback → close `4001 UNAUTHORIZED`, sem revelar o motivo (o log interno
   registra `UNKNOWN_SERVER`, `UNKNOWN_CREDENTIAL`, `CREDENTIAL_SERVER_MISMATCH`,
   `CREDENTIAL_REVOKED`, `INVALID_SECRET` ou `SERVER_DISABLED`); nenhuma entrada
   de registry, nenhum `AUTHENTICATED`, e a sessão anterior segue intacta.
2. **Promoção pós-commit:** a sessão entra no registry como **AUTHENTICATING**
   (invisível para `getSession`, `isConnected`, `isRuntimeReady`, `supports` e
   `send`; visível para revogação e limpeza) → revalida no banco que a linha da
   sessão continua `CONNECTED` e a credencial continua `ACTIVE` → sem nenhum
   `await` entre a revalidação positiva e a ativação, promove para **ACTIVE** →
   só então fecha a sessão anterior (`4006 SUPERSEDED`) → envia `AUTHENTICATED`.
   As promoções de um servidor são serializadas em memória, na ordem de commit.

Revogação × HELLO: se o revoke commita antes da leitura de revalidação, ela o vê
e a sessão fecha com `4009` sem ficar ACTIVE; se commita depois, o fechamento
pós-commit do revoke encontra a sessão (AUTHENTICATING ou ACTIVE) e a fecha. Em
nenhuma ordem uma sessão de credencial REVOKED termina ACTIVE. Se a nova sessão
é recusada depois do commit (revogada, ou já superada por uma HELLO mais nova), a
anterior só é fechada se o banco já a marcou como encerrada; se ela continua
`CONNECTED`, permanece ACTIVE.

Sucesso → frame `AUTHENTICATED`, com `payload`: `inReplyTo`, `connectionId`
(= `game_connections.id`), `heartbeatIntervalMs`, `heartbeatTimeoutMs`,
`maxFrameBytes` e `serverTime`. Nada de segredo.

O `externalConnectionId` de cada sessão é um UUID novo gerado pelo backend por
socket (o Game Bridge nunca reutiliza um id encerrado); o Agent não o envia.

### 4.4 Sessão, runtime e heartbeat

`game_connections` **é** a sessão do Host Agent. Colunas acrescentadas:
`credential_id` (FK), `capabilities` (jsonb array, ≤ 64), `game_process_state`,
`skse_ready`. `bridge_version` passa a guardar a versão do Host Agent (sem coluna
duplicada). CHECK: sessões com credencial têm runtime; sessões abertas pelo serviço
interno, sem transporte, não têm. `disconnect_reason` passou a ter CHECK.

**Runtime** (fechado na 11.1): `UNKNOWN`, `STOPPED`, `STARTING`, `RUNNING`, `PAUSED`,
`STOPPING`, `RESTARTING`, mais `skseReady: boolean`. Não há `CRASHED`: um processo
que caiu é `STOPPED` (ou `RESTARTING` enquanto o Agent o recupera). **Game ready =
`RUNNING` e `skseReady`.**

**HEARTBEAT** (autenticado):

```json
{ "...envelope": "...", "type": "HEARTBEAT",
  "payload": { "gameProcessState": "RUNNING", "skseReady": true, "capabilities": ["…"] } }
```

`capabilities` é opcional (ausente = mantém as anunciadas). O backend chama
`GameConnectionService.heartbeat`, que atualiza `last_heartbeat_at` e o runtime; se
o banco disser que a sessão não está mais ativa (servidor desabilitado, sessão
substituída ou vencida), o socket fecha com `4011 SESSION_CLOSED`. Caso contrário
responde `HEARTBEAT_ACK { inReplyTo, serverTime }`.

**Timeout:** uma varredura periódica em memória (a cada `min(intervalo, 1 s)`, sem
timer por conexão) encerra sessões sem heartbeat há `AGENT_HEARTBEAT_TIMEOUT`:
linha `DISCONNECTED / STALE`, socket `4008 HEARTBEAT_TIMEOUT`, registry sem a
sessão. Nenhum status novo foi criado.

| Variável | Padrão | Regra |
| --- | --- | --- |
| `AGENT_AUTH_TIMEOUT_MS` | 5000 | 100–60000; prazo para o HELLO chegar |
| `AGENT_HEARTBEAT_INTERVAL` | `10s` | anunciado ao Agent no AUTHENTICATED |
| `AGENT_HEARTBEAT_TIMEOUT` | `30s` | > intervalo e ≤ `GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS` (um socket vivo sempre tem sessão saudável no Game Bridge) |

### 4.5 Ciclo de vida da conexão

| Evento | Sessão (`disconnect_reason`) | Socket |
| --- | --- | --- |
| Zero Agents | nenhuma `CONNECTED`; GameCommand e Server Control ficam PENDING (sem gastar tentativa nem cruzar a fronteira de entrega) até o respectivo pending timeout → `FAILED / DISPATCH_EXPIRED` | — |
| Agent fecha com 1000 | `REQUESTED` | — |
| Queda/fechamento sem 1000, violação de protocolo pós-auth | `CLOSED` | código do motivo |
| Novo HELLO do mesmo servidor autenticado com sucesso | anterior `SUPERSEDED` (na transação do novo) | anterior `4006 SUPERSEDED` só depois de a nova ficar ACTIVE; HELLO que falha ou faz rollback não afeta a anterior |
| Heartbeat vencido | `STALE` | `4008` |
| Credencial revogada | `CREDENTIAL_REVOKED` | `4009` |
| Backend encerrando | `SHUTDOWN` | `1001` |
| Backend iniciando | toda linha `CONNECTED` restante vira `BACKEND_RESTART` (sockets não sobrevivem a restart; histórico mantido) | — |

Conexões duplicadas: uma sessão ativa por servidor, garantida pelo índice parcial
único existente e pelo lock do servidor; duas HELLO simultâneas serializam no
banco e a última **autenticada com sucesso** (commit + promoção) vence; registry e
banco concordam. A reconciliação de startup
fecha tudo em SINGLE e só sessões com lease vencida em MULTI (12.5).

Códigos de close: `4000 AUTH_TIMEOUT`, `4001 UNAUTHORIZED`, `4003 PROTOCOL_ERROR`,
`4005 PROTOCOL_UNSUPPORTED`, `4006 SUPERSEDED`, `4008 HEARTBEAT_TIMEOUT`,
`4009 CREDENTIAL_REVOKED`, `4010 SERVER_MISMATCH`, `4011 SESSION_CLOSED`,
`1001 SHUTDOWN`, e `1009` do próprio `ws` para frame grande.

### 4.6 Session registry e router

`AgentSessionRegistry` (memória, um por instância) tem dois estados internos:
**AUTHENTICATING** (por `connectionId`, só para revogação/limpeza/shutdown) e
**ACTIVE** (índice `gameServerId`, o único visível às leituras públicas e a
`send`). Não há enum no protocolo nem no banco. Cada sessão guarda
`connectionId`, `gameServerId`, `credentialId`, `agentVersion`, capabilities,
runtime, `connectedAt`, `lastHeartbeatAt` e o socket; sem regra de domínio. API
para as próximas subetapas: `getSession`, `isConnected`, `isRuntimeReady`,
`supports(capability)`, `send(gameServerId, connectionId, frame)` (só para aquela
sessão, nunca redirecionado), `supportsCommand(type)` (11.2),
`supportsServerControl(type)` e `updateRuntime` (11.3). O `AgentGameGateway`, o
worker da 11.2 e o `AgentServerControlGateway` da 11.3 os usam (§8.3, §9.1).

`AgentMessageRouter` recebe só frames autenticados: `gameServerId` do frame ≠ da
sessão → `4010`; `HEARTBEAT` → tratado; `COMMAND_ACK`/`COMMAND_RESULT` → adapter de
GameCommand (11.2); `SERVER_CONTROL_RESULT` → adapter de Server Control (11.3);
`DOMAIN_EVENT` e `WORK_SYNC` → adapter de domínio (11.4, §10.2); `ERROR` do Agent → logado; `HELLO`
repetido, tipos só de saída ou desconhecidos → `4003`. O router não
importa repositórios nem `typeorm` (teste de fronteira).

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
  "payload": { "inReplyTo": "messageId, só em respostas" }
}
```

**11.1:** o envelope tem exatamente essas seis chaves nos dois sentidos
(`src/game-agent/agent-protocol.contracts.ts`); `inReplyTo` fica dentro do
`payload` das respostas (`AUTHENTICATED`, `HEARTBEAT_ACK`, `ERROR`) para o
envelope ser idêntico em entrada e saída.

- Adaptação ao projeto: `CommandEnvelope` usa `serverId`, não `gameServerId`. O
  envelope externo usa `gameServerId`; o interno mantém `serverId`. Ambos devem
  coincidir com o servidor **da sessão autenticada**; divergência → `ERROR
  SERVER_MISMATCH` e close.
- `messageId` identifica o **frame** (log, correlação `inReplyTo`, dedup de
  transporte). **Não** é chave de domínio: GameCommand usa `commandId`, eventos
  usam `eventId`, Server Control usa `operationId`.
- Chaves extras no envelope ou no payload → rejeição (mesma regra "closed" de
  `actor()` e dos DTOs).
- Frames binários → protocol error. Tamanho máximo de frame: **128 KiB**
  (`MAX_AGENT_FRAME_BYTES`, único lugar; cabe um result de 64 KiB mais envelope;
  o realtime continua com 16 KiB). Acima disso o `ws` fecha com `1009` antes de
  qualquer parse.
- Frame malformado (JSON inválido, chaves extras, tipos errados) → close `4003`
  imediato, antes ou depois da autenticação.
- Compatibilidade: campos novos só em versão nova. **11.1 aceita somente `"1"`**,
  sem negociação nem fallback: outra versão → close `4005 PROTOCOL_UNSUPPORTED`,
  sem sessão. Uma lista de versões suportadas no HELLO fica para quando existir
  uma segunda versão. Versões antigas são removidas só com janela de depreciação
  documentada.

## 6. Message types

| Tipo | Direção | Payload | Resposta | Subetapa |
| --- | --- | --- | --- | --- |
| `HELLO` | A → B | credencial, `agentVersion`, capabilities, runtime (§4.3) | `AUTHENTICATED` ou close | 11.1 ✔ |
| `AUTHENTICATED` | B → A | `connectionId`, intervalos, limite de frame, `serverTime` | — | 11.1 ✔ |
| `HEARTBEAT` | A → B | estado do processo, `skseReady`, capabilities opcionais (a sessão vem do socket) | `HEARTBEAT_ACK` | 11.1 ✔ |
| `HEARTBEAT_ACK` | B → A | `inReplyTo`, `serverTime` | — | 11.1 ✔ |
| `COMMAND` | B → A | `commandId`, `correlationId`, `attempt`, `type`, `payload`, `issuedAt`, `ackDeadlineAt`, `executionDeadlineAt` (§8.3) | `COMMAND_ACK` e depois `COMMAND_RESULT` | 11.2 ✔ |
| `COMMAND_ACK` | A → B | `commandId`, `correlationId`, `attempt` | nenhuma | 11.2 ✔ |
| `COMMAND_RESULT` | A → B | `commandId`, `correlationId`, `outcome` (+ `result` ou `errorCode`) | `COMMAND_RESULT_ACK` ou `ERROR` | 11.2 ✔ |
| `COMMAND_RESULT_ACK` | B → A | `inReplyTo`, `commandId`, `status`, `accepted`, `duplicate` | — | 11.2 ✔ |
| `SERVER_CONTROL` | B → A | `operationId`, `correlationId`, `type`, `issuedAt`, `notAfter` (§9.1) | `SERVER_CONTROL_RESULT` (sem ACK) | 11.3 ✔ |
| `SERVER_CONTROL_RESULT` | A → B | `operationId`, `correlationId`, `type`, `outcome` (+ `errorCode` se FAILED), `runtime?` | `SERVER_CONTROL_RESULT_ACK` ou `ERROR` | 11.3 ✔ |
| `SERVER_CONTROL_RESULT_ACK` | B → A | `inReplyTo`, `operationId`, `status`, `accepted`, `duplicate` | — | 11.3 ✔ |
| `DOMAIN_EVENT` | A → B | `{ eventId, kind, data }`, `kind` fechado, `data` exato por kind (§10.2) | `DOMAIN_EVENT_ACK` ou `ERROR` | 11.4 ✔ |
| `DOMAIN_EVENT_ACK` | B → A | `inReplyTo`, `eventId`, `kind`, `duplicate` (só após o commit) | — | 11.4 ✔ |
| `WORK_SYNC` | A → B | `kind?`, `cursor?`, `limit?` (1–50); nunca servidor | `WORK_ITEMS` | 11.4 ✔ |
| `WORK_ITEMS` | B → A | `inReplyTo` (ou `null` no push), `items[]`, `nextCursor` | — | 11.4 ✔ |
| `ERROR` | ambos | `code`, `inReplyTo?`, `retryable` | — | 11.1 ✔ (`NOT_IMPLEMENTED`) |

Não há `GOODBYE`: o encerramento gracioso é o close `1000` do WebSocket
(sessão `REQUESTED`). Na 11.1 os erros de autenticação e protocolo são **códigos
de close** (§4.5); o frame `ERROR` só responde a mensagens válidas cujo fluxo ainda
não existe (`NOT_IMPLEMENTED`). `ERROR.code` continua catálogo fechado (próximos:
`UNKNOWN_COMMAND`, `RESULT_CONFLICT`, `TEMPORARILY_UNAVAILABLE`, `RATE_LIMITED`);
nunca stack trace, SQL ou texto de exceção.

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
- Incerteza (exceção/timeout no send, queda com claim, RESULT ausente até o
  prazo) **não** vira retry: vira o estado terminal `UNCERTAIN` (11.3) e exige
  nova solicitação humana com nova `Idempotency-Key`.
- Agent deduplica por `operationId` mesmo assim e recusa operação vencida
  (`notAfter`), para que um frame atrasado não reinicie o servidor minutos depois.

**Domain events — at-least-once com dedup no backend**
- O Agent gera `eventId` **persistente** (gravado antes de enviar) e reenvia até
  receber `DOMAIN_EVENT_ACK` (ou um `ERROR` não retryable).
- O backend deduplica de forma **uniforme** em `agent_domain_event_receipts`
  (servidor da sessão + `eventId`), gravado **na mesma transação** do efeito de
  domínio (11.4, §10.2); as chaves de cada domínio (§2.3) continuam valendo por
  baixo.
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

O **worker** da 11.2 (§8.3) é o chamador de produção do lifecycle: não há dispatch
síncrono no request; o próximo tick (padrão 500 ms) despacha o command.

### 8.1 ACK vs RESULT (decidido; **implementado na 11.2**)

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
| malformed (envelope, contrato, tamanho) | envelope/tamanho: close `4003`/`1009` (já na 11.1); contrato de result: rejeitado `INVALID_MESSAGE` |
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

### 8.3 Implementado na 11.2

**Gateway real.** `AgentGameGateway` (`src/game-agent/agent-game.gateway.ts`) é o
provider de produção de `GameGateway`; `DisconnectedGameGateway` continua existindo
para testes/fallback. Ele é chamado pelo dispatcher depois do commit da reserva, sem
transação aberta, e só escreve no socket da **sessão exata** da reserva
(`connectionId`). Devolve `UNAVAILABLE` (não-entrega comprovada, nada escrito) se a
sessão mudou ou sumiu, se o runtime deixou de estar pronto ou se a capability não
existe mais; nunca escolhe outra sessão. O registry vive em `AgentSessionModule`,
compartilhado pelo Game Bridge e pelo transporte sem ciclo de módulos.

**COMMAND (B → A).** Payload: `commandId`, `correlationId`, `attempt` (número da
tentativa = `dispatchAttempts` na reserva), `type`, `payload` tipado, `issuedAt`,
`ackDeadlineAt`, `executionDeadlineAt`. Servidor e sessão vêm do envelope/socket. Não
vão: `idempotencyKey` HTTP (escopo do backend; a identidade de execução é
`commandId`), ator, staff/player, Audit, tokens. `CommandEnvelope` interno ganhou
`attempt`.

**COMMAND_ACK (A → B)** `{ commandId, correlationId, attempt }`: pertence à
tentativa. A sessão (connectionId) vem do socket; é aceito só se for a sessão da
tentativa atual e o `attempt` for o atual. ACK duplicado é no-op; ACK de tentativa
antiga (outra sessão ou outro `attempt`) é ignorado e logado (`STALE_ATTEMPT`), sem
resposta e sem mudar a tentativa nova; commandId desconhecido → `ERROR
UNKNOWN_COMMAND`; command de outro servidor → close `4010`. ACK não prova sucesso.

**COMMAND_RESULT (A → B)** `{ commandId, correlationId, outcome }` com:
`SUCCEEDED` + `result` (contrato tipado do tipo, ≤ 64 KiB; o frame de 128 KiB não
amplia o limite de domínio), `FAILED` + `errorCode` (`EXECUTION_FAILED`,
`BRIDGE_ERROR`; `PING_REJECTED` só para ping) ou `UNCERTAIN` (sem campos extras).
Nenhuma mensagem livre é aceita (o backend grava a do catálogo). Pertence ao
command: aceito por qualquer sessão ativa e saudável do mesmo servidor, inclusive
depois de reconexão; `connectionId` da tentativa fica como procedência.

| Caso | Resposta |
| --- | --- |
| aceito | `COMMAND_RESULT_ACK { status, accepted: true, duplicate: false }` |
| idêntico repetido | `COMMAND_RESULT_ACK { duplicate: true }`, sem escrita nem Audit |
| deadline vencido antes | `COMMAND_RESULT_ACK { status: TIMEOUT, accepted: false }` (não reabre) |
| conflitante com o terminal | `ERROR RESULT_CONFLICT` |
| commandId desconhecido | `ERROR UNKNOWN_COMMAND` |
| command nunca despachado (PENDING sem reserva) | `ERROR NOT_DISPATCHED` |
| payload/contrato/tamanho inválido, correlationId divergente | `ERROR INVALID_MESSAGE`, nada persistido |
| command de outro servidor | close `4010 SERVER_MISMATCH` |
| banco indisponível | `ERROR TEMPORARILY_UNAVAILABLE`, `retryable: true` |

`SUCCEEDED → SUCCEEDED`, `FAILED → FAILED`, `UNCERTAIN → TIMEOUT /
EXECUTION_UNCERTAIN` (nunca FAILED). Rejeições tipadas vêm de `BridgeRejection`
(`src/game-bridge/bridge-rejection.ts`), ainda 409 para chamadores HTTP.

**Capabilities (fechadas).** `GAME_COMMAND_V1` (protocolo), uma capability por
tipo com o nome exato do `CommandType`, e `COMMAND_DEDUP_V1` (journal durável). A
classificação QUERY/MUTATION é única (`COMMAND_KINDS`,
`src/game-bridge/command-kinds.ts`, `Record` completo sobre os 32 tipos; 9 queries).
`supportsCommand(capabilities, type)` = protocolo + tipo + (QUERY ou dedup). Sem
dedup, queries seguem e mutations ficam PENDING (logado). Capability nunca substitui
RBAC/ownership, e o Agent não cria commands nem escolhe ator (teste de fronteira).

**Worker** (`GameCommandWorker`, um `setInterval` sem sobreposição,
`GAME_COMMAND_WORKER_INTERVAL_MS`, padrão 500 ms): `expireCommands`, depois
`expirePending`, depois, para cada sessão ACTIVE com runtime pronto
(`RUNNING` + `skseReady`), despacha retries devidos e PENDING dos tipos suportados
dentro do orçamento em voo. **Elegibilidade antes da reserva:** Agent ausente,
runtime não pronto ou capability ausente não consomem tentativa. A corrida entre o
check e o send existe; se o runtime cair depois da reserva, a tentativa falha pelo
lifecycle normal (`UNAVAILABLE`) e o retry continua permitido.

**Expiração de PENDING (decisão da 11.2).** No modelo existente o prazo total só
começa na primeira reserva; sem Agent elegível um command ficaria PENDING para
sempre. Agora PENDING sem reserva há `GAME_COMMAND_PENDING_TIMEOUT_MS` (padrão 60 s)
termina `FAILED / DISPATCH_EXPIRED`: PENDING sem lease comprova que nada foi
entregue. Sem migration (status e transição já existiam).

**Em voo.** `AGENT_MAX_IN_FLIGHT_COMMANDS` (padrão 32) por servidor, contado **no
banco** (DISPATCHED, ACKNOWLEDGED e PENDING com reserva viva), então sobrevive a
restart. No limite o worker não despacha PENDING novos (sem gastar tentativa);
retries de commands já em voo continuam.

**Rate limit.** `AGENT_MESSAGE_RATE_LIMIT_COUNT` / `_WINDOW_MS` (padrão 200 / 10 s),
janela fixa em memória por sessão, só frames autenticados. Excedido → log e close
`4012 RATE_LIMITED`. In-memory porque protege o socket/processo local (instância
única; Etapa 12).

**Liveness única.** O gateway Agent (heartbeat em memória + varredura) é o dono da
sessão; `game_connections.last_heartbeat_at` é atualizado a cada heartbeat e
`healthy()` usa `GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS ≥ AGENT_HEARTBEAT_TIMEOUT`, então
as duas leituras concordam. `markStaleConnections` **não** é agendado: seria um
segundo dono da mesma sessão; permanece como manutenção interna.

**Restart.** Registry vazio; sessões reconciliadas (§4.5); PENDING continuam no
banco e são despachados quando um Agent elegível se conecta; DISPATCHED/ACKNOWLEDGED
seguem a política existente (retry com o mesmo `commandId` ou TIMEOUT pelo prazo);
nada é reexecutado às cegas.

**Audit.** Inalterado: só a criação do command (quando o domínio audita). ACK e
RESULT não geram Audit.

**Logs** (`chave=valor`, sem payloads): `Game command dispatched/retried`, `not sent:
session changed | runtime not ready | capability missing`, `acknowledged`, `Stale
game command ACK ignored`, `result accepted | duplicate | superseded by deadline`,
`Conflicting game command result rejected`, `Unknown game command`, `execution
uncertain`, `held: runtime not ready | Agent capability missing`, `expired without an
eligible Agent`, `message rate limit exceeded`; com `commandId`, `gameServerId`,
`commandType`, `connectionId` e `attempt`.

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

## 9. ServerControl flow (11.3 — implementado)

```text
Staff POST /control/{start|pause|restart} ─► ServerControlService (op PENDING + Audit, tx; 409 se houver outra em voo) ─► commit
   └─► dispatch (logo após o commit, e depois pelo ServerControlWorker):
          target(servidor, tipo) = sessão ACTIVE com SERVER_CONTROL_V1 + capability do tipo?
            ├─ não ─► continua PENDING, sem claim (nada enviado) ─► pending timeout ─► FAILED / DISPATCH_EXPIRED
            └─ sim ─► CLAIM (UPDATE autocommit: connectionId, notAfter, resultDeadlineAt) ══ fronteira de entrega ══
                        └─► AgentServerControlGateway.send ─► um único frame SERVER_CONTROL para aquela sessão
                               ├─ nada escrito (sessão trocou, capability sumiu, socket fechado) ─► FAILED / AGENT_UNAVAILABLE
                               └─ escrito ou ambíguo ─► DISPATCHED
Agent: journal(operationId) RECEIVED ─► confere notAfter ─► EXECUTING ─► ação supervisionada ─► COMPLETED
   └─► SERVER_CONTROL_RESULT (qualquer sessão do servidor) ─► SUCCEEDED | FAILED | UNCERTAIN ─► SERVER_CONTROL_RESULT_ACK
resultDeadlineAt vencido sem RESULT ─► UNCERTAIN / RESULT_TIMEOUT (nunca FAILED, nunca reenvio)
```

### 9.1 Implementado na 11.3

**Inventário preservado (Etapa 09).** Tipos `SERVER_START`, `SERVER_PAUSE`,
`SERVER_RESTART` (não existe STOP); permissions homônimas (COORDINATOR, DEV); Audit
`SERVER_*_REQUESTED` na criação; `operationId` = PK; claim por `dispatch_claimed_at`
num UPDATE autocommit; `ServerControlGateway` abstrato com send limitado a 1 s.
Server Control **não** usa GameCommand, `GameCommandBus`, `GameGateway` nem o
worker de GameCommand (teste de fronteira).

**Garantia: at-most-once.** A **fronteira de entrega é o claim**: o UPDATE que,
numa só instrução (`status = PENDING`, sem claim, servidor habilitado), grava
`dispatch_claimed_at`, a sessão alvo (`dispatch_connection_id`), `not_after` e
`result_deadline_at`. Antes dele nada foi enviado: a operação pode esperar (Agent
offline) ou falhar com segurança (`FAILED`). Depois dele a operação **pode** ter
chegado ao Agent e **nunca** volta para a fila: nenhum caminho (request, worker,
reconexão, restart, heartbeat timeout, ACK ausente, RESULT perdido) a envia de
novo. A falta de prova do resultado vira `UNCERTAIN`.

**Lifecycle.**

| De | Para | Quando |
| --- | --- | --- |
| PENDING (sem claim) | FAILED `SERVER_DISABLED` | servidor desabilitado antes do claim |
| PENDING (sem claim) | FAILED `DISPATCH_EXPIRED` | nenhum Agent elegível até `SERVER_CONTROL_PENDING_TIMEOUT_MS` |
| PENDING (claim) | FAILED `AGENT_UNAVAILABLE`/`AGENT_REJECTED` | o gateway provou que nada foi escrito |
| PENDING (claim) | DISPATCHED | frame escrito, ou send ambíguo (exceção/timeout) |
| PENDING (claim) / DISPATCHED | SUCCEEDED / FAILED / UNCERTAIN | RESULT do Agent antes do prazo |
| PENDING (claim) / DISPATCHED | UNCERTAIN `RESULT_TIMEOUT` | `result_deadline_at` vencido |

`UNCERTAIN` é **terminal** e significa "o backend não consegue afirmar se a ação
executou". Nunca é usado para erro conhecido do Agent (isso é `FAILED`), e
`FAILED` significa "definitivamente sem efeito". Checks no banco: `UNCERTAIN` só
com claim; `FAILED`/`UNCERTAIN` sempre com `error_code`; claim sempre com os dois
prazos.

**Uma operação em voo por servidor.** No máximo uma operação `PENDING` ou
`DISPATCHED` por `game_server_id`: checagem sob o lock da linha de `game_servers`
(já usado pela idempotência) e índice parcial único
`server_control_operations_active_key` como garantia final. Outra solicitação →
409 `Another server control operation is in progress`; replay da mesma
`Idempotency-Key` continua devolvendo a mesma operação. `UNCERTAIN` libera o
servidor: o operador pode pedir de novo (nova chave), vendo a incerteza anterior
no read model. O receiver trava só a linha da operação (nunca `game_servers`),
então RESULT e nova solicitação concorrentes não fazem deadlock.

**Gateway real.** `AgentServerControlGateway`
(`src/game-agent/agent-server-control.gateway.ts`) é o provider de produção;
`DisconnectedServerControlGateway` fica como fallback de teste. `target()` exige
só sessão ACTIVE + capability; **não** exige `RUNNING` nem `skseReady` (START com
Skyrim parado). `send()` escreve só na sessão fixada no claim; se ela mudou
(inclusive por conexão duplicada), se a capability sumiu ou o socket fechou,
devolve `UNAVAILABLE` sem escrever nada e nunca troca de sessão.

**Capabilities (fechadas).** `SERVER_CONTROL_V1` (protocolo **e** journal durável:
at-most-once depende dele, então não há capability de dedup separada) + uma por
ação, com o nome exato do tipo (`SERVER_START`, `SERVER_PAUSE`, `SERVER_RESTART`).
`supportsServerControl()` em `agent-capabilities.ts`. Capabilities de GameCommand
não valem aqui, e nenhuma capability autoriza: RBAC é do backend.

**SERVER_CONTROL (B → A).** `{ operationId, correlationId, type, issuedAt,
notAfter }`; servidor e sessão vêm do envelope/socket. Não vão: JWT, ator, staff,
`Idempotency-Key`, texto de comando, caminho, script, argumentos, ambiente.
`notAfter = claim + SERVER_CONTROL_DELIVERY_WINDOW_MS` (padrão 10 s): o Agent
**recusa executar** depois disso e responde `FAILED / DELIVERY_EXPIRED`. `notAfter`
não autoriza retry pelo backend.

**Sem ACK.** Não existe `SERVER_CONTROL_ACK`: uma operação é enviada uma vez em
qualquer caso, então um ACK não mudaria nenhuma decisão (nem retry, nem prazo).
O `RESULT` fecha o lifecycle e o prazo cobre sua ausência.

**SERVER_CONTROL_RESULT (A → B).** `{ operationId, correlationId, type, outcome }`
com `outcome` ∈ `SUCCEEDED`, `FAILED` + `errorCode` ∈ (`DELIVERY_EXPIRED`,
`INVALID_PROCESS_STATE`, `EXECUTION_FAILED`), `UNCERTAIN` (journal encontrou
EXECUTING sem prova → `UNCERTAIN / OUTCOME_UNKNOWN`), e `runtime?`
(`{ gameProcessState, skseReady }`). Sem mensagem livre, stack ou campo extra.
Pertence a `gameServerId` + `operationId`: aceito de qualquer sessão ativa e
saudável do mesmo servidor (reconexão); `dispatch_connection_id` é só procedência.

| Caso | Resposta |
| --- | --- |
| aceito | `SERVER_CONTROL_RESULT_ACK { status, accepted: true, duplicate: false }` |
| igual ao terminal (dois "desconhecidos" também concordam) | `SERVER_CONTROL_RESULT_ACK { duplicate: true }`, sem escrita |
| prazo vencido antes | `SERVER_CONTROL_RESULT_ACK { status: UNCERTAIN, accepted: false }` |
| diferente do terminal (inclusive após UNCERTAIN por prazo) | `ERROR RESULT_CONFLICT` |
| operationId desconhecido | `ERROR UNKNOWN_OPERATION` (nada é criado) |
| `type` diferente da operação | `ERROR OPERATION_MISMATCH` |
| antes do claim | `ERROR NOT_DISPATCHED` |
| payload inválido, correlationId divergente | `ERROR INVALID_MESSAGE` |
| operação de outro servidor | close `4010 SERVER_MISMATCH` |
| banco indisponível | `ERROR TEMPORARILY_UNAVAILABLE`, `retryable: true` |

**Runtime após o RESULT.** Se vier `runtime`, atualiza o snapshot da sessão
(registry) e de `game_connections` (UPDATE autocommit, sem lock do servidor e sem
contar como heartbeat). O outcome explícito continua sendo a autoridade: START
SUCCEEDED pode vir com `STARTING`; o backend nunca infere sucesso do snapshot.

**Journal do Host Agent (requisito).** `operationId` é a identidade de execução.
Antes de agir, o Agent grava `RECEIVED`, confere `notAfter`, grava `EXECUTING`,
age e grava `COMPLETED` com o outcome, de forma durável (sobrevive a restart). A
mesma `operationId` recebida de novo (bug/replay) nunca é executada outra vez.
Após reconectar, reenvia o RESULT de `COMPLETED` até receber
`SERVER_CONTROL_RESULT_ACK`; `EXECUTING` sem prova → `UNCERTAIN`. O simulador de
Agent dos e2e (`test/support/fake-agent.ts`) implementa isso.

**Worker.** `ServerControlWorker` (`src/server-control/server-control.worker.ts`),
separado do de GameCommand e **sem retry**: a cada
`SERVER_CONTROL_WORKER_INTERVAL_MS` (padrão 1 s), sem sobreposição, (1) PENDING sem
claim além do pending timeout → `FAILED / DISPATCH_EXPIRED`; (2) claim com
`result_deadline_at` vencido → `UNCERTAIN / RESULT_TIMEOUT`; (3) primeiro e único
dispatch das PENDING sem claim cujo servidor tem Agent elegível. As transições
(1) e (2) são UPDATEs cercados pelo mesmo predicado do claim/receiver, então
exatamente um vence.

**Prazos (persistidos, reconstruíveis após restart).**

| Variável | Padrão | Papel |
| --- | --- | --- |
| `SERVER_CONTROL_PENDING_TIMEOUT_MS` | 30000 | PENDING nunca enviada → FAILED `DISPATCH_EXPIRED` |
| `SERVER_CONTROL_DELIVERY_WINDOW_MS` | 10000 | `notAfter` = claim + janela |
| `SERVER_CONTROL_RESULT_TIMEOUT_MS` | 300000 | claim sem RESULT → UNCERTAIN; > janela (validado) |
| `SERVER_CONTROL_WORKER_INTERVAL_MS` | 1000 | cadência do worker |

**Restart do backend.** Nada depende de timer em memória. PENDING sem claim
continua elegível para o primeiro e único dispatch; PENDING com claim (queda entre
claim e reconciliação) e DISPATCHED **não** são reenviados: aguardam o RESULT até
`result_deadline_at` e depois viram UNCERTAIN. **Restart do Agent:** o journal
reenvia o RESULT; nada é reexecutado.

**Migration 24 (`1790030000000-ServerControlTransport`).** Status `UNCERTAIN`;
colunas `dispatch_connection_id` (FK `game_connections`), `not_after`,
`result_deadline_at`; checks de claim/UNCERTAIN/erro/conclusão; índice parcial
único de uma operação em voo e índice `(status, result_deadline_at)`. Dados da
Etapa 09: operações com claim ainda abertas viram `UNCERTAIN / RESULT_TIMEOUT` (não
havia receptor de resultado) e PENDING sem claim viram `FAILED / DISPATCH_EXPIRED`
(nada enviado); isso também garante o índice. `down` converte `UNCERTAIN` de volta
para o `DISPATCHED` "possivelmente entregue" e os novos códigos para
`AGENT_UNAVAILABLE`/`AGENT_REJECTED`.

**Audit.** Inalterado: só a linha de criação (`SERVER_*_REQUESTED`). RESULT e
prazos não geram Audit; `UNCERTAIN` fica visível no read model
(`GET /server-control-operations/:id`: `status`, `errorCode`, `errorMessage`).

**Logs** (`chave=valor`, sem payload): `Server control dispatched`, `not sent:
session changed | capability missing | socket closed`, `send ambiguous`, `held: no
eligible Agent`, `expired before dispatch`, `result accepted | duplicate |
superseded by deadline`, `Conflicting server control result`, `Unknown server
control operation`, `action mismatch`, `of another server`, e `Server control
outcome UNCERTAIN` com `metric=server_control_uncertain_total` (exige atenção
operacional); com `operationId`, `gameServerId`, `action`, `connectionId`.

**GameCommand vs Server Control.**

| | GameCommand (11.2) | Server Control (11.3) |
| --- | --- | --- |
| Entrega | at-least-once, retries com o mesmo `commandId` | at-most-once, nunca reenviado |
| Prontidão | sessão + `RUNNING` + `skseReady` + capability | sessão + capability (sem runtime) |
| ACK | `COMMAND_ACK` por tentativa | nenhum |
| Desconhecido | `TIMEOUT / EXECUTION_UNCERTAIN` | `UNCERTAIN` (`RESULT_TIMEOUT` / `OUTCOME_UNKNOWN`) |
| Concorrência | até `AGENT_MAX_IN_FLIGHT_COMMANDS` por servidor | 1 operação em voo por servidor |
| Worker | `GameCommandWorker` (retries) | `ServerControlWorker` (sem retry) |

## 10. Domain event routing (11.4 — implementado)

```text
AgentGateway (ws, frame ≤ 128 KiB, rate limit por sessão, estado AUTH)
      │  frames autenticados
      ▼
AgentMessageRouter            (sem regra de negócio, sem typeorm/entities)
      │  gameServerId do envelope = sessão, senão 4010
      ├─ DOMAIN_EVENT ─► AgentDomainEventAdapter ─► AgentDomainEventService
      │                     (parse fechado)            (tabela kind → handler,
      │                                                  receipt, dedup)
      │                                                    ▼
      │                                  entry points de domínio (confirmFromAgent, grantFromAgent)
      └─ WORK_SYNC ────► AgentDomainEventAdapter ─► AgentWorkService ─► projeções read-only
                                                                          (TradeWorkSource, MarketplaceWorkSource)
```

### 10.1 Work recovery: `WORK_SYNC` / `WORK_ITEMS`

Mantidos os princípios da 11.0: recovery depois de toda (re)conexão, push
best-effort que pode coexistir, catálogo fechado, backend como autoridade e
itens derivados das tabelas de domínio no momento do pedido. Detalhes em §10.2.

### 10.2 Implementado na 11.4

**Inventário dos entry points (reais).**

| Entry point | Parâmetros | Transação | Idempotência | Servidor | Ator | Realtime |
| --- | --- | --- | --- | --- | --- | --- |
| `CharacterLinkService.confirmFromAgent` | `challenge`, `gameServerId`, `characterExternalId` | 1 tx: link → challenge → player | challenge single-use (hash); replay → `ALREADY_VERIFIED` | já recebia; challenge de outro servidor → `CHALLENGE_MISMATCH` | `SYSTEM:AGENT` (Audit) | `PLAYER_CHARACTER_LINK_UPDATED` após commit (11.5) |
| `ProfessionExperienceService.grantFromAgent` | `gameServerId`, `characterExternalId`, `eventId`, `amount` | 1 tx: lock da profissão | UNIQUE(`game_server_id`, `external_event_id`) | já recebia (é a identidade) | `SYSTEM:AGENT` (Audit) | nenhum |
| `TradeSettlementService.confirmFromAgent` | `tradeId`, `settlementEventId`, `outcome` **+ `gameServerId` (11.4)** | `mutate`: trade → escrow → ledger; realtime pós-commit | UNIQUE(servidor, event) + UNIQUE(trade) | **não conferia** → agora `SERVER_MISMATCH` | `SYSTEM:AGENT` (Audit) | `TRADE_COMPLETED`/`FAILED` |
| `MarketplaceCustodyService.confirmFromAgent` | `listingId`, `custodyEventId`, `outcome` **+ `gameServerId`** | `mutate`: listing | idem | **não conferia** → `SERVER_MISMATCH` | `SYSTEM:AGENT` | `MARKETPLACE_LISTING_ACTIVE`/`FAILED` |
| `MarketplaceSettlementService.confirmFromAgent` | `purchaseId`, `settlementEventId`, `outcome` **+ `gameServerId`** | `mutate`: listing → purchase → escrow → ledger | idem | **não conferia** → `SERVER_MISMATCH` | `SYSTEM:AGENT` | `…_SOLD` / `…_PURCHASE_FAILED` |
| `MarketplaceReleaseService.confirmFromAgent` **(novo)** | `releaseId`, `releaseEventId`, `outcome`, `gameServerId` | `mutate`: listing → release | UNIQUE(servidor, `release_event_id`) + status | `SERVER_MISMATCH` | `SYSTEM:AGENT` (Audit `…_ITEM_RELEASED`/`…_RELEASE_FAILED`) | nenhum |
| `VipDeliveryService` (reescrito) | — (worker) | 1 tx por delivery: entitlement → delivery → `submitInTransaction` | idempotency key `vip-delivery:<deliveryId>` | servidor do entitlement | `SYSTEM:VIP_DELIVERY` | nenhum |

Todos ganharam um parâmetro opcional `onAccepted: AgentEventHook`
(`src/actors/agent-event.contracts.ts`), chamado **dentro da transação do domínio**
imediatamente antes de um resultado aceito (aplicado ou já aplicado) commitar.

**DOMAIN_EVENT (A → B).** `{ eventId, kind, data }`: `eventId` UUID, identidade
persistente de entrega; `kind` do catálogo fechado `AGENT_EVENT_KINDS`
(`agent-domain-event.contracts.ts`); `data` com chaves exatas por kind (campo extra
→ `INVALID_MESSAGE`):

| kind | data | Serviço |
| --- | --- | --- |
| `CHARACTER_OWNERSHIP_PROOF` | `challenge`, `characterExternalId` | `CharacterLinkService.confirmFromAgent` |
| `PROFESSION_EXPERIENCE` | `characterExternalId`, `amount` (`eventId` vira `externalEventId`) | `ProfessionExperienceService.grantFromAgent` |
| `TRADE_SETTLEMENT` | `workId` (= tradeId), `outcome` `SUCCEEDED`\|`SETTLED` (legado)\|`FAILED` | `TradeSettlementService` |
| `MARKETPLACE_CUSTODY` | `workId` (= listingId), `outcome` `SUCCEEDED`\|`CUSTODIED` (legado)\|`FAILED` | `MarketplaceCustodyService` |
| `MARKETPLACE_SETTLEMENT` | `workId` (= purchaseId), `outcome` `SETTLED`\|`FAILED` | `MarketplaceSettlementService` |
| `MARKETPLACE_RELEASE` | `workId` (= releaseId), `outcome` `RELEASED`\|`FAILED` | `MarketplaceReleaseService` |

Não existe evento genérico (`entity/action/payload`), comando ou script. Novo kind =
mudança explícita (parser, handler, CHECK). Nenhum kind aceita `playerId`, link,
status final, servidor, GOLD, preço, quantidade, item, participante ou nível.

**Respostas (sempre depois do commit).**

| Caso | Frame |
| --- | --- |
| aplicado | `DOMAIN_EVENT_ACK { eventId, kind, duplicate: false }` |
| mesmo `eventId` e mesmo conteúdo (retry, reconexão, restart) ou domínio já aplicado | `DOMAIN_EVENT_ACK { duplicate: true }`, sem segundo efeito |
| mesmo `eventId` com outro conteúdo ou outro kind | `ERROR EVENT_CONFLICT` |
| recusa final do domínio (ex.: `EXPIRED_CHALLENGE`, `PROFESSION_NOT_SELECTED`, `TRADE_NOT_AWAITING`) | `ERROR DOMAIN_REJECTED { reason, retryable: false }` (persistida: o mesmo `eventId` recebe a mesma resposta) |
| recusa retryable (`LEDGER_REJECTED`, `SERVER_UNAVAILABLE`) | `ERROR DOMAIN_REJECTED { retryable: true }`, nada persistido |
| work de outro servidor | close `4010 SERVER_MISMATCH`, nada muda |
| payload/kind inválido | `ERROR INVALID_MESSAGE` |
| exceção (banco) | `ERROR TEMPORARILY_UNAVAILABLE`, `retryable: true` |

**Dedup uniforme (`agent_domain_event_receipts`).** PK (`game_server_id`,
`event_id`), `kind`, `content_hash` (SHA-256 do JSON canônico de `{kind, data}`),
`status` `APPLIED`\|`REJECTED`, `reason`. Nunca guarda o payload (o challenge não é
persistido). Transação por evento: parse → leitura do receipt (duplicado/conflito)
→ serviço de domínio abre sua transação e trava a entidade canônica → confere o
servidor da sessão → aplica → **hook grava o receipt** (`ON CONFLICT DO NOTHING`;
se outra entrega do mesmo `eventId` venceu, a transação faz rollback e a resposta
vem do receipt vencedor) → commit → realtime do domínio → ACK. Não existe janela
"domínio commitou sem receipt": ambos são o mesmo commit (teste: se o receipt falha,
nem o XP nem o evento de domínio ficam). Receipt não é Audit.

**Server binding.** `gameServerId` vem sempre da sessão. Trade/Marketplace/release
conferem o servidor da entidade dentro da transação → `SERVER_MISMATCH` + close
`4010` (injeção cross-server), nenhuma mutação. Ownership: challenge de outro
servidor é `DOMAIN_REJECTED CHALLENGE_MISMATCH` **sem** fechar a sessão — o
challenge é digitado pelo jogador; fechar o Agent por um código errado seria um
vetor de negação de serviço. Profession: a identidade é (servidor da sessão,
character), então outro servidor é outra profissão.

**WORK_SYNC / WORK_ITEMS.** `WORK_SYNC { kind?, cursor?, limit? }` (limite 1–50,
padrão 50); o servidor é o da sessão. `WORK_ITEMS { inReplyTo, items, nextCursor }`
com `items[] = { workId, kind, createdAt, data }`, catálogo `AGENT_WORK_KINDS`:

| kind | Origem (canônica) | data | workId |
| --- | --- | --- | --- |
| `TRADE_SETTLEMENT` | trades `AWAITING_GAME_CONFIRMATION` | `tradeId`, personagens, `initiatorItems`/`targetItems` (GAME_ITEM + qtd) | tradeId |
| `MARKETPLACE_CUSTODY` | listings `PENDING_CUSTODY` | `listingId`, seller, item, qtd | listingId |
| `MARKETPLACE_SETTLEMENT` | purchases `AWAITING_GAME_CONFIRMATION` | `purchaseId`, `listingId`, buyer, seller, item, qtd | purchaseId |
| `MARKETPLACE_RELEASE` | releases `PENDING` | `releaseId`, `listingId`, seller, item, qtd | releaseId |

Nunca GOLD, preço ou regra econômica. Paginação: kinds na ordem fixa; dentro de
cada kind, keyset (instante canônico em µs, id) — sem offset. Cursor opaco
(base64url), validado estritamente. Página limitada a 50 itens **e** 96 KiB (um
trade pode ter 20 linhas por lado), abaixo do frame de 128 KiB. Nada é marcado
"entregue" por aparecer num `WORK_ITEMS`: socket que cai não perde nada; o próximo
`WORK_SYNC` devolve o mesmo trabalho com o mesmo `workId`. Trabalho que commita
durante uma passada pode aparecer só na próxima passada ou no push.

**Push best-effort.** `AgentWorkNotifier` (`AGENT_WORK_PUSH_INTERVAL_MS`, padrão
2 s) lê a primeira página canônica de cada sessão ACTIVE e envia, como
`WORK_ITEMS { inReplyTo: null }`, só os itens ainda não avisados àquela conexão
(memória limitada, só otimização). Roda fora de qualquer transação de domínio;
domínios não o chamam; falha de socket não reverte nada.

**Journal do Host Agent por `workId` (requisito).** Entrega de work é
at-least-once: o mesmo `workId` pode chegar várias vezes (sync, push, reconexão).
O Agent grava em journal durável `workId → fase` antes de cada efeito físico,
nunca repete um efeito já feito e, ao receber de novo um work já concluído,
reenvia o mesmo `DOMAIN_EVENT` (mesmo `eventId`), que resulta em ACK duplicado.

**Ownership.** Player cria o challenge → digita no jogo → Agent envia
`CHARACTER_OWNERSHIP_PROOF { challenge, characterExternalId }` → o backend
resolve challenge, player e link. Preservados: hash, TTL, single use, escopo por
servidor, regras de conflito. O challenge não é logado nem persistido. Desde a 11.5 há
`PLAYER_CHARACTER_LINK_UPDATED` após commit, somente para o dono; HTTP continua canônico.

**Professions.** `eventId` do protocolo = `externalEventId`. O Agent só informa o
fato (`characterExternalId`, `amount`); nível, teto e regras seguem no serviço.
Retry não duplica XP; recusa é final para o `eventId` (persistida).

**Trade.** O backend continua autoridade de ofertas, aceite, GOLD, escrow e
elegibilidade; o work traz só os itens físicos que o backend já determinou.
`TRADE_SETTLEMENT SUCCEEDED` confirma fulfillment físico completo, registrado
no journal por workId; `SETTLED` é o alias legado com a mesma semântica. Só então
GOLD é liquidado e Trade vira `COMPLETED` (settled). Não resta entrega física
invisível depois disso. Enquanto incompleto, o work permanece em `WORK_SYNC`.
Reconnect recupera o mesmo workId, sem repetir transferências conhecidas.
`FAILED` libera GOLD apenas quando há falha física definitiva.

**Marketplace.** Custody → `ACTIVE`; purchase → work de settlement → `SETTLED` paga
o seller pelo preço da listing → `SOLD`. **Release (novo):**
`player_marketplace_item_releases` (`PENDING`→`COMPLETED`\|`FAILED`, `reason`
`CANCELLED`\|`PURCHASE_FAILED`), criada **na mesma transação** que cancela uma
listing `ACTIVE` ou falha um settlement; o id é o `workId`. Um item custodiado nunca
é esquecido: a release fica pendente até o Agent reportar. Custody adquirida
(`SUCCEEDED`, alias de `CUSTODIED`) que chega após `CANCELLED`/`FAILED` cria ou
garante a release persistente sem reativar a listing. Sem aquisição confirmada,
nenhuma release é criada. Lock da listing + UNIQUE(listing_id) garantem uma única
obrigação independentemente dos receipts e de novos eventIds equivalentes.
Release concluída não é reaberta. O histórico anterior permanece imutável;
`PURCHASE_FAILED` é o reason existente reutilizado para listing FAILED.
`WORK_SYNC` recupera a devolução com o mesmo release workId após reconnect.
Servidor diferente recebe `SERVER_MISMATCH` sem mutação. Backend é a fonte de
verdade das obrigações pendentes; journal deduplica a execução física.

**VIP delivery.** Decisão de alvo: **só scope CHARACTER** gera entrega (o
entitlement já nomeia servidor + character). Scope PLAYER continua direito da
conta: nenhum character é escolhido (nem primeiro, nem último, nem o mais recente);
um produto PLAYER com reward in-game exigirá um fluxo explícito de claim/target.
`vip_reward_deliveries`: uma linha por reward (índice + snapshot), criada na mesma
transação do grant. Estados `PENDING` → `COMMAND_CREATED` → `SUCCEEDED` \| `FAILED` \|
`UNCERTAIN`, ou `CANCELLED` / `FAILED UNSUPPORTED_REWARD` sem command. Mapeamento
fechado: `ITEM → CHARACTER_ITEM_GIVE`, `HORSE → CHARACTER_HORSE_GIVE`,
`TITLE → CHARACTER_TITLE_GIVE`, `SPELL → CHARACTER_SPELL_GIVE` (reward sem command
tipado nunca é entregue; nada de console/Papyrus/script). Reutiliza o GameCommand
da 11.2: `submitInTransaction` com ator `SYSTEM:VIP_DELIVERY` e idempotency key
`vip-delivery:<deliveryId>`; o Agent vê só `commandId` e payload tipado. O worker
(`VIP_DELIVERY_WORKER_INTERVAL_MS`, padrão 2 s) só cria o command quando o servidor
tem Agent pronto com a capability (senão a entrega espera, sem consumir o direito)
e reconcilia pelo `game_command_id`: `SUCCEEDED → SUCCEEDED`, `FAILED → FAILED`
(código do command), `TIMEOUT`/`EXECUTION_UNCERTAIN → UNCERTAIN`; nunca cria outro
command. **Revoke/expiração:** antes do command → `CANCELLED`, nada entregue
(checado sob o lock do entitlement, mesma ordem do revoke); depois do command → sem
"desexecução" nem clawback, o command segue seu lifecycle; `SUCCEEDED` já entregue
não é removido. Entitlements concedidos antes da 11.4 não ganham deliveries (não
havia snapshot); decisão aberta (§23).

**Audit.** Transporte técnico não audita. Os domínios mantêm exatamente seu Audit
(`SYSTEM:AGENT`); a release audita no mesmo padrão de custody/settlement; VIP não
cria Audit novo (o GameCommand já tem ator `SYSTEM:VIP_DELIVERY`).

**Logs** (sem challenge, payload, JWT ou credencial): `Agent domain event applied |
duplicate | conflict | rejected by the domain (reason) | for another server's work
rejected`, com `eventId`, `kind`, `gameServerId`, `connectionId`, `workId`;
`Agent work sync (count, more)`; `Agent work pushed`; `VIP delivery command created
| held | succeeded | failed | uncertain | ended without command` com `deliveryId`.

**Restart.** Receipts, releases, deliveries e work vivem no banco: evento concluído
não reaplica (receipt), work pendente reaparece no `WORK_SYNC`, delivery reconcilia
pelo `game_command_id`, release `PENDING` reaparece. Nada depende de memória.

**Migration 25 (`1790040000000-AgentDomainEvents`).** As três tabelas, com CHECKs de
coerência. Backfill: listings já `CANCELLED`/`FAILED` com custódia `CUSTODIED`
ganham release `PENDING`. `down` recusa enquanto houver release `PENDING` ou
delivery `PENDING`/`COMMAND_CREATED` (obrigações abertas); histórico terminal é
perdido no rollback.

## 11. Character verification

```text
Player (Electron) POST /player/character-links { gameServerId, characterExternalId }
   ◄── 201 { link PENDING, challenge "ABCD-EFGH-JKLMN", expiresAt }   (hash SHA-256 no banco)
Player digita o challenge no jogo (comando/diálogo do mod)
SKSE → Agent: { challenge, characterExternalId do personagem logado }
Agent ─ DOMAIN_EVENT CHARACTER_OWNERSHIP_PROOF { eventId, challenge, characterExternalId } ─► Router
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
- `eventId` é a identidade de entrega (receipt, §10.2); a idempotência de domínio
  continua sendo o challenge.
- O Agent não deve logar nem persistir o challenge além do necessário para o
  reenvio; tentativas repetidas de challenges inválidos por um mesmo character
  devem ser limitadas no Agent (brute force de 64 bits é inviável, mas spam não).
- Desde a 11.5, `PLAYER_CHARACTER_LINK_UPDATED` acorda somente o dono após
  commit; Electron refaz GET (§16).

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
`TRADE_AWAITING_GAME_CONFIRMATION` para players. O Agent recupera o trabalho por
`WORK_SYNC` e recebe push best-effort de `WORK_ITEMS`.

Sequência (implementada na 11.4, §10.2):

```text
Backend: trade → AWAITING (GOLD RESERVED)            [commit]
Backend ─ WORK_ITEMS { kind: TRADE_SETTLEMENT, workId = tradeId, parties, items } ─► Agent
          (push após commit + WORK_SYNC em todo (re)connect; §10.1)
Agent: executa todas as transferências aos destinatários, journal por workId
Agent ─ DOMAIN_EVENT TRADE_SETTLEMENT { eventId, workId, outcome: SUCCEEDED } ─► Backend
Backend (tx): settle GOLD, COMPLETED, evento gravado, Audit ─► ACK

LEDGER_REJECTED ─► continua AWAITING, GOLD RESERVED; reenvia o mesmo sucesso
                   sem repetir as transferências já concluídas
```

- **Invariante:** sucesso confirma fulfillment físico completo. Trade settled =
  fulfillment físico confirmado + settlement econômico concluído. Não há
  entrega física posterior à conclusão.
- **Crash recovery:** o Agent persiste `(workId, eventId, fase)` por transferência.
  Reconexão antes da conclusão recupera o mesmo workId em WORK_SYNC e retoma
  apenas o restante. Resposta perdida → mesmo evento → duplicate ACK, sem
  repetir efeitos físicos ou GOLD. Após o commit, o work desaparece.
- **Escopo (11.4):** `gameServerId` da sessão conferido na transação (§10.2).
- **Lacuna de produto:** trade AWAITING não expira e o Player não pode cancelar.
  Se o Agent nunca responder, o GOLD fica reservado indefinidamente. Fora deste delta:
  timeout operacional com `FAILED` iniciado pelo backend **somente** se o
  Agent confirmar que não tem custódia, ou ação de operador.

## 14. Marketplace

Estado atual: create → `PENDING_CUSTODY`; custody → `ACTIVE`; purchase →
`RESERVED` + purchase `AWAITING_GAME_CONFIRMATION` + escrow; settlement →
`SOLD`/`FAILED`; cancel de `PENDING_CUSTODY`/`ACTIVE` → `CANCELLED`. **O Agent não
é avisado de nenhuma dessas transições.**

Sequência (implementada na 11.4; kinds finais em §10.2: `MARKETPLACE_CUSTODY`,
`MARKETPLACE_SETTLEMENT`, `MARKETPLACE_RELEASE`):

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
   Listing CANCELLED ou FAILED com custody confirmada, inclusive confirmação tardia
          ─ release PENDING persistente
          ─ WORK_ITEMS { kind: MARKETPLACE_RELEASE, workId: releaseId } ─► Agent devolve ao seller
   Agent ─ DOMAIN_EVENT MARKETPLACE_RELEASE { eventId, workId, outcome: RELEASED }
          ─► Backend marca release COMPLETED
```

- **Invariante:** item só sai da custódia para o buyer depois do `APPLIED` de
  `SETTLED`; para o seller, depois de `CANCELLED`/`FAILED` confirmados no backend.
- **Estado de devolução (11.4):** `player_marketplace_item_releases` (§10.2),
  uma por listing, inclusive para custody adquirida confirmada após cancellation/failure.
  Listing continua terminal; a release fica em WORK_SYNC até COMPLETED/FAILED.
- **Crash recovery:** `WORK_SYNC` é recalculado a partir das tabelas de domínio,
  incluindo releases; reconnect recupera o mesmo workId. O journal deduplica a
  devolução física e o receipt deduplica o evento.
- **Escopo (11.4):** `gameServerId` da sessão conferido nos três serviços.

## 15. VIP delivery

Estado atual: `VipDeliveryService.requestDelivery` sempre retorna
`UNAVAILABLE/AGENT_NOT_INTEGRATED`; não há estado de entrega. Os rewards
(`VipReward`) já são exatamente os payloads de `CHARACTER_ITEM_GIVE`,
`CHARACTER_HORSE_GIVE`, `CHARACTER_TITLE_GIVE` e `CHARACTER_SPELL_GIVE` sem
`characterId`, e `SystemSource.VIP_DELIVERY` já é aceito pelos CHECKs.

Recomendação da 11.0 (a implementação final da 11.4 está em §10.2; estados:
`PENDING`, `COMMAND_CREATED`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, `CANCELLED`):

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
| GameServers | `GET player/game-servers?page&limit` | nenhum; HTTP periódico | backend: servidores habilitados + heartbeat/runtime persistidos | não | só fornece runtime |
| Characters | `POST player/character-links`, `GET player/character-links/:linkId`, `POST player/character-links/:linkId/revoke`, `GET player/me/characters[/:characterLinkId]` | `PLAYER_CHARACTER_LINK_UPDATED` | backend; verificação pelo Agent | não | **sim** (ownership) |
| Profile / Skills | `POST player/game-servers/:gameServerId/characters/:characterId/{profile,skills}-query`, `GET player/character-operations/:operationId` | `PLAYER_GAME_OPERATION_UPDATED` (GET do result; polling fallback) | Skyrim via GameCommand | não | **sim** |
| Properties / Holds / Horses | `POST …/{properties,holds,horses}-query`, `GET player/character-operations/:operationId` | `PLAYER_GAME_OPERATION_UPDATED` (GET do result; polling fallback) | Skyrim via GameCommand | não | **sim** |
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

### 11.5 implementada — contrato Electron/Launcher

Contrato completo por tela, bodies, auth, startup, realtime/reconciliação e IPC:
[Electron integration](electron-integration.md). Electron e C# Launcher não estão
neste repositório. A 11.5 fecha apenas os contratos e gaps do Backend.

- `GET /api/v1/player/game-servers`: PlayerAuthGuard, paginação, somente enabled;
  allowlist `id/code/name/enabled/agentConnected/gameProcessState/gameReady`.
  Liveness usa heartbeat persistido e regra existente do Bridge; gameReady exige
  Agent saudável, RUNNING e SKSE pronto. Sessão inexistente/stale oculta snapshot
  (gameProcessState null, gameReady=false). Disabled some da descoberta, histórico não.
  Nenhum Agent internal/credential, write de estado ou Audit no GET.
- `PLAYER_CHARACTER_LINK_UPDATED`: PENDING/VERIFIED/REVOKED, após commit do link
  (incluindo receipt Agent); só dono. Payload `characterLinkId`, `gameServerId`,
  `characterExternalId`, `status`, `updatedAt`. Sem challenge/proof/hash/playerId.
- `PLAYER_GAME_OPERATION_UPDATED`: transição terminal SUCCEEDED/FAILED/TIMEOUT,
  inclusive EXECUTION_UNCERTAIN e expirações/falhas locais. Só actor PLAYER,
  destinatário `requestedByPlayerId` persistido, nunca ownership atual.
  Payload `operationId/status/errorCode/completedAt`; sem result bruto, ACK,
  dispatch/retry ou dados Agent. Commit antes da notificação; rollback e
  duplicate não notificam. Staff/SYSTEM não entram nesse evento.
- Eventos são best-effort; falha de listener não reverte transação e não gera
  Audit adicional. Frame segue 16 KiB; result (até 64 KiB) só em HTTP. Reconnect
  exige refetch; não há replay queue. Wallet usa eventos Trade/Marketplace para
  invalidar saldo e refaz GET, sem evento econômico duplicado.
- Groups tem GET por groupId e invites pendentes, mas não listagem de memberships
  atuais. O cliente precisa preservar/revalidar IDs conhecidos; recuperação após
  perdê-los é um gap documentado, sem nova Group API na 11.5.
- Sem migrations: continuam 25. Agent protocol, GameCommand lifecycle e Server
  Control não mudam. Confirmar callback/PKCE e IPC contra os repos externos.

## 17. Local Launcher boundary

O código do Electron e do Launcher C# **não está neste repositório**; 11.5 define o contrato esperado de IPC em [electron-integration.md](electron-integration.md),
sem validar implementação externa. Runtime remoto do Host Agent e processo
Skyrim local do Launcher são independentes.

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
| Server Control | `POST game-servers/:serverId/control/{start,pause,restart}`, `GET game-servers/:serverId/control/operations` (11.6), `GET server-control-operations/:operationId` |
| Realtime | surface `STAFF`: desde a 11.6 recebe `STAFF_GAME_SERVER_UPDATED`, `STAFF_GAME_OPERATION_UPDATED` e `STAFF_SERVER_CONTROL_UPDATED`, filtrados pela permissão do GET correspondente |

O contrato completo do Admin Web (matriz, eventos, permissões, cold start) está em
`docs/admin-web-integration.md`. Na 11.6 `GET game-servers/:id` também passou a
expor `currentConnection.gameProcessState` e `skseReady`.

Sem Agent real, todas as operações de runtime aceitam e persistem (202) mas nunca
concluem. Não existem, e 11.0 não cria: telas/rotas Admin para players, character
links, trades, marketplace, economia, grant/revoke HTTP de VIP entitlements e
credenciais do Agent. A de credenciais é necessária para operar 11.1 (ou CLI); as
demais são decisões de produto. Admin Web e Electron continuam consumidores independentes: nenhuma comunicação
Electron → Admin Web ou Admin Web → Electron foi criada na 11.5.

## 19. Realtime boundaries

| Superfície | Path | Auth | Direção | Fonte de verdade |
| --- | --- | --- | --- | --- |
| Player realtime | `/api/v1/realtime`, `surface: PLAYER` | Player access JWT no frame AUTH | só servidor → cliente (cliente só envia AUTH) | não; HTTP é |
| Staff realtime | `/api/v1/realtime`, `surface: STAFF` | Staff access JWT no frame AUTH; grants relidos a cada entrega | só servidor → cliente; 3 wake-ups `STAFF_*` (11.6) | não |
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
| Agent offline | banco | GameCommand fica PENDING sem gastar tentativa → FAILED `DISPATCH_EXPIRED`; Server Control fica PENDING **sem claim** → FAILED `DISPATCH_EXPIRED` (nada enviado, nunca UNCERTAIN); eventos esperam no Agent | sim | reconectar o Agent; reenviar operações humanas |
| Agent conectado, Skyrim parado ou SKSE não pronto | banco + runtime reportado | GameCommand não é enviado (`UNAVAILABLE`, sem escrita no socket); segue TTL/tentativas atuais; Server Control funciona | sim | iniciar o jogo (START) se desejado |
| Agent reconnect | banco (`game_connections`) | novo HELLO → nova sessão com novo `externalConnectionId` gerado pelo backend; sessão anterior SUPERSEDED; `WORK_SYNC`; RESULTs pendentes reenviados pela nova sessão; **reconexão não implica replay de side effect** | sim | nenhuma |
| Conexão duplicada (mesmo servidor) | banco (índice parcial único) | a mais nova vence; a antiga recebe close `SUPERSEDED` e suas mensagens são rejeitadas | sim | investigar se não for reconexão legítima (credencial vazada?) |
| Backend restart | banco | sockets caem; Agent reconecta; leases expiram → DISPATCHED conservador; workers retomam; Server Control com claim **não** é reenviado: aceita o RESULT até `result_deadline_at`, depois UNCERTAIN | sim (GameCommand); Server Control só pelo RESULT | revisar operações UNCERTAIN |
| Agent restart | journal durável do Agent | Agent reconecta, reenvia eventos sem resposta, responde re-envios de command pelo journal (safe replay) | sim **se** o journal é durável | se o journal se perdeu: reconciliar manualmente |
| Mensagem duplicada (frame) | chaves de domínio | — | sim (no-op) | nenhuma |
| ACK de tentativa antiga (outra sessão) | banco | descartado; ACK é attempt-bound | sim | nenhuma |
| Result duplicado | `game_command_results` UNIQUE | idêntico → no-op (em qualquer sessão válida do servidor); diferente → `RESULT_CONFLICT`, original preservado | sim | investigar conflito (bug do Agent) |
| Result de outro GameServer | sessão autenticada | rejeitado `SERVER_MISMATCH`, sessão encerrada | sim | investigar credencial/Agent |
| Evento duplicado | tabelas de evento por domínio | `ALREADY_APPLIED` / `ALREADY_VERIFIED` | sim | nenhuma |
| Payload malformado | — | close `4003` imediato (11.1) | sim | corrigir Agent |
| Protocol mismatch | — | `PROTOCOL_UNSUPPORTED` + close; sem retry até atualizar | sim | atualizar Agent/backend |
| Credencial revogada | banco (credenciais) | close; HELLO rejeitado; sem retry com a mesma | sim | emitir nova credencial |
| Banco indisponível | — | HELLO/eventos → `TEMPORARILY_UNAVAILABLE` retryable; dispatcher não reserva | sim (retry com backoff) | restaurar banco |
| Dispatch committed, socket morre antes do send | banco (lease) | lease expira → DISPATCHED; retry na nova sessão com os mesmos ids | sim (Agent dedup) | nenhuma |
| Agent executa, result se perde (conexão cai) | journal do Agent + banco | Agent reconecta e reenvia o RESULT pela nova sessão; aceito por ser do mesmo GameServer e do mesmo command (§8.1, implementado na 11.2) | sim | nenhuma |
| Agent encaminha ao SKSE e cai antes de saber o resultado (command mutável) | journal (`FORWARDED` sem resultado) | **não reexecuta**; recupera o resultado pelo SKSE se possível, senão reporta UNCERTAIN → TIMEOUT `EXECUTION_UNCERTAIN` | sim (sem duplicar efeito) | verificar no jogo e corrigir manualmente |
| Backend commita result e a conexão cai antes de responder | banco | Agent reenvia o mesmo result por qualquer sessão válida → `COMMAND_RESULT_ACK { duplicate: true }` | sim | nenhuma |
| Server Control: send ambíguo ou reconexão | banco + journal do Agent | **nunca** reenviado nem reexecutado automaticamente; RESULT da mesma operação aceito pela nova sessão; sem RESULT até o prazo → `UNCERTAIN / RESULT_TIMEOUT` | — (at-most-once) | verificar o servidor; nova solicitação se necessário |
| Server Control entregue tarde ao Agent | `notAfter` no frame | Agent recusa: `FAILED / DELIVERY_EXPIRED`, nada executado | — | nova solicitação |
| Server Control: capability ausente | registry | não há claim; PENDING → FAILED `DISPATCH_EXPIRED` | sim | atualizar o Agent |
| Result tardio após TIMEOUT | banco (TIMEOUT imutável) | 409 conflito | não reabre | **efeito pode ter ocorrido**: métrica + reconciliação manual |
| DOMAIN_EVENT sem ACK (socket caiu) | receipt no banco | Agent reenvia o mesmo `eventId` → ACK `duplicate: true`, sem segundo efeito | sim | — |
| Receipt não pode ser gravado | transação do domínio | rollback do efeito e do receipt; `TEMPORARILY_UNAVAILABLE` retryable | sim | — |
| Agent do servidor B conclui work do servidor A | entidade de domínio | `SERVER_MISMATCH`, close 4010, nada muda | — | investigar credencial |
| Work perdido (push falhou, socket caiu durante WORK_ITEMS) | tabelas de domínio | próximo `WORK_SYNC` devolve o mesmo `workId` | sim | — |
| Listing ACTIVE cancelada / settlement FAILED | `player_marketplace_item_releases` | release PENDING até o Agent reportar | sim | release FAILED → operador |
| VIP CHARACTER sem Agent pronto | `vip_reward_deliveries` | fica PENDING sem command | sim | — |
| VIP command TIMEOUT / EXECUTION_UNCERTAIN | delivery UNCERTAIN | nunca cria outro command | — | verificar no jogo |
| Entitlement revogado/expirado antes do command | delivery | CANCELLED, nada entregue | — | — |

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
| Flood de mensagens | 11.1: HELLO com prazo (`AGENT_AUTH_TIMEOUT_MS`), um frame processado por vez por socket, frame ≤ 128 KiB. 11.2: cota por sessão (`AGENT_MESSAGE_RATE_LIMIT_*`, close `4012 RATE_LIMITED`) e limite de GameCommands em voo por servidor contado no banco |
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
| Server Control desconhecido (claim sem resultado, deadline) | log `metric=server_control_uncertain_total` + alerta | 11.3 ✔ (log) |
| Trabalhos pendentes (trades AWAITING, listings PENDING_CUSTODY, purchases AWAITING, VIP UNCERTAIN) | gauge | query |

Stack de métricas (Prometheus/OpenTelemetry) não é adicionada na Etapa 11; os
sinais podem começar como logs estruturados e consultas ao banco.

**11.1 — logs em vigor** (Nest `Logger`, formato `mensagem [chave=valor …]`, só ids
validados): `Agent authenticated` (servidor, conexão, credencial, versão,
runtime), `Agent authentication rejected` (motivo interno), `Agent session
superseded`, `Agent disconnected` (código), `Agent heartbeat timeout`, `Agent
protocol version rejected`, `Agent malformed frame`, `Agent protocol violation`,
`Agent frame for another server rejected`, `Agent session closed: credential
revoked`, `Agent credential created/revoked`, `Agent sessions closed on startup`.
Nunca aparecem segredo, hash, JWT nem payloads. O histórico por motivo continua em
`game_connections.disconnect_reason`.

## 23. Open decisions

| Decisão | Quando |
| --- | --- |
| Códigos de erro remoto mais específicos por domínio (hoje `EXECUTION_FAILED` / `BRIDGE_ERROR`), se o Agent real precisar | quando houver uso |
| Backpressure do socket (bufferedAmount) no `AgentGameGateway` | Etapa 12 / hardening |
| Regras de aceitação pelo estado de processo reportado (ex.: START com `RUNNING` → 409 no backend); hoje o Agent recusa com `INVALID_PROCESS_STATE` | quando houver uso |
| Contador/métrica exportada de UNCERTAIN (hoje log estruturado); a lista para o Admin Web existe desde a 11.6 (`GET game-servers/:serverId/control/operations?status=UNCERTAIN`) | Etapa 12 |
| Expiração/resolução de trades e purchases AWAITING (e releases PENDING/FAILED) sem resposta do Agent: timeout operacional ou ação de operador | produto / Etapa 12 |
| Fluxo explícito de claim/target para rewards in-game de entitlements PLAYER | produto |
| Deliveries VIP para entitlements CHARACTER concedidos antes da 11.4 (sem snapshot) | produto (a nova tentativa de delivery FAILED/UNCERTAIN por operador foi feita na 12.4: `docs/operational-recovery.md` §5.7–5.8) |
| Listagem Player de operações (desnecessária enquanto toda operação Player for query; Groups foi resolvido na 11.6 com `GET player/me/characters/:characterLinkId/group`) | quando existir operação Player que não seja query |
| Backpressure avançado do realtime além do corte por `bufferedAmount` (256 KiB) e distribuição multi-instância do bus | Etapa 12 |
| Quais ações de gameplay geram XP e quanto | produto |
| Sincronização de gold do jogo com o ledger (hoje: não existe) | produto |
| Transporte/shapes finais do IPC local e callback/PKCE Electron | validar contra repos externos |
| Multi-instância do backend (roteamento de sockets, broker) | Etapa 12 |

## 24. Mapping para 11.1–11.6

A divisão proposta foi **confirmada**, com o escopo abaixo. Nenhuma subetapa nova.

| Subetapa | Escopo | Migration provável |
| --- | --- | --- |
| **11.0** Integration Discovery + Contracts | este documento | não |
| **11.1** Game Agent Transport + Authentication — **implementada** | roteador de upgrade único; `WebSocketServer` do Agent; credenciais (SHA-256, até 2 ACTIVE, revogação com close imediato) e Staff API; HELLO/AUTHENTICATED/HEARTBEAT/HEARTBEAT_ACK/ERROR; `game_connections` como sessão do Host Agent com runtime/SKSE/capabilities; varredura de heartbeat; supersede; reconciliação de startup e shutdown; limite de frame; `AgentMessageRouter` com `NOT_IMPLEMENTED` e testes de fronteira. Fora: rate limit por segundo e `BRIDGE_PING` ponta a ponta (dependem do dispatch, 11.2) | `1790020000000-GameAgentTransport` (23 migrations; permission + 2 grants) |
| **11.2** GameCommand Execution + Results — **implementada** | `AgentGameGateway` como provider de produção; `GameCommandWorker`; COMMAND/COMMAND_ACK/COMMAND_RESULT/COMMAND_RESULT_ACK; gate por runtime + capability antes da reserva; capabilities fechadas e dedup obrigatório para mutations; RESULT independente da sessão; UNCERTAIN → TIMEOUT; expiração de PENDING; em voo contado no banco; rate limit por sessão | nenhuma (23 migrations) |
| **11.3** Server Control Real Transport — **implementada** | `AgentServerControlGateway`; `ServerControlWorker` sem retry; SERVER_CONTROL / SERVER_CONTROL_RESULT / SERVER_CONTROL_RESULT_ACK (sem ACK de recepção); `UNCERTAIN` terminal; claim como fronteira de entrega; `notAfter`; prazos persistidos; RESULT por `gameServerId` + `operationId` após reconexão; uma operação em voo por servidor | `1790030000000-ServerControlTransport` (24 migrations) |
| **11.4** Agent Domain Events + Gameplay Delivery — **implementada** | `DOMAIN_EVENT`/`DOMAIN_EVENT_ACK` com kinds fechados; receipts atômicos (`agent_domain_event_receipts`); ownership, profession, trade, marketplace custody/settlement/release; `gameServerId` da sessão nos serviços de Trade/Marketplace; `WORK_SYNC`/`WORK_ITEMS` paginado + push best-effort; `player_marketplace_item_releases`; VIP CHARACTER delivery por GameCommand `SYSTEM:VIP_DELIVERY` | `1790040000000-AgentDomainEvents` (25 migrations) |
| **11.5** Electron / Launcher Integration Contract — **implementada** | Player GameServer discovery; realtime de link e operação terminal Player após commit; contrato HTTP/realtime, auth/startup e IPC local em `electron-integration.md`; sem UI/Launcher externos | nenhuma (25 migrations) |
| **11.6** End-to-End Realtime + Integration Validation — **implementada** | realtime Staff com filtro de permissão revalidado na entrega; wake-ups de GameServer, GameCommand Staff e Server Control; runtime do Agent no GET de servidor; lista de Server Control; group por character; corte de cliente lento; bateria final combinada (§25) | nenhuma (25 migrations) |

11.4 é a mais extensa; se crescer demais, a divisão natural é "eventos de
confirmação" (ownership, XP) antes de "custódia e entrega" (trade, marketplace,
VIP), mantendo a numeração.

## 25. Encerramento da Etapa 11 (11.6)

### 25.1 O que a 11.6 acrescentou

- **Realtime Staff.** `RealtimeEventBus` aceita destino Player (`playerIds`) ou
  Staff (`staffPermission`), nunca os dois; tipos `STAFF_*` só vão para Staff e os
  demais só para Players (o bus descarta a publicação trocada). O gateway entrega
  evento Staff apenas a sockets cuja sessão, conta e role atuais, relidas por
  `AuthService.authenticate` a cada entrega, têm a permissão. Sessão inválida
  fecha o socket com 4001.
- **`STAFF_GAME_SERVER_UPDATED`** (GAME_BRIDGE_READ), por
  `GameServerStatusNotifier` em game-bridge: chamado depois de cada commit que
  pode mudar o estado (HELLO ativado, fim de sessão, supersede, stale, revogação,
  runtime em heartbeat ou em resultado de Server Control); relê o banco e publica
  só se o estado difere do último publicado. game-agent continua sem importar
  realtime.
- **`STAFF_GAME_OPERATION_UPDATED`** (GAME_BRIDGE_READ), no mesmo ponto de
  transição terminal de `GameCommandStore.locked` que já produzia o evento
  Player, para commands com actor STAFF.
- **`STAFF_SERVER_CONTROL_UPDATED`** (permissão do tipo), após cada escrita
  terminal: resultado do Agent, UNCERTAIN por deadline e FAILED antes da entrega.
- **Leituras de recuperação**: runtime do Agent em `GET game-servers/:id`;
  `GET game-servers/:serverId/control/operations`;
  `GET player/me/characters/:characterLinkId/group`. Nenhuma migration.
- **Cliente lento**: socket com mais de 256 KiB não lidos é derrubado; não existe
  fila por cliente.

Ordem: nenhum evento realtime promete ordem global nem sequence; todos são
publicados depois do commit, podem duplicar ou faltar, e significam só "refaça o
GET". Cada protocolo mantém sua garantia: GameCommand at-least-once (dedup no
journal do Agent por commandId), Server Control at-most-once (claim como fronteira),
work de domínio at-least-once + journal por workId + receipt por eventId,
realtime best effort.

### 25.2 Matriz de aceitação

"Evidência" são testes deste repositório contra PostgreSQL real, HTTP e sockets
reais. O Host Agent é o `FakeAgent` do repo (protocolo v1 real, journal simulado);
Agent/SKSE, Electron, Launcher e o provider OAuth reais não estão aqui e não são
cobertos.

| Item | Resultado | Evidência |
| --- | --- | --- |
| Agent auth/connect | PASS | `game-agent.e2e-spec.ts`; separação de credenciais em `stage11-integration.e2e-spec.ts` |
| GameCommand dispatch/result | PASS | `game-command-agent.e2e-spec.ts`; Staff GameCommand ponta a ponta em `stage11-integration` |
| GameCommand reconnect result | PASS | `game-command-agent` (RESULT por nova sessão, retry); matriz de reconnect em `stage11-integration` |
| ServerControl at-most-once | PASS | `server-control-agent.e2e-spec.ts`; nunca reenviado após reconnect e após restart real em `stage11-integration` |
| ServerControl UNCERTAIN | PASS | `server-control-agent`; UNCERTAIN + wake-up + GET + lista em `stage11-integration` |
| Domain event dedup | PASS | `agent-domain-events.e2e-spec.ts`; retry do mesmo eventId após reconnect em `stage11-integration` |
| WORK_SYNC recovery | PASS | `agent-domain-events`; mesmo workId após conexão caída, concluído uma vez, em `stage11-integration` |
| Ownership via Agent | PASS | `agent-domain-events`, `electron-integration.e2e-spec.ts`, `stage11-integration` |
| Professions via Agent | PASS | `agent-domain-events` (eventId único, servidor da sessão), `professions.e2e-spec.ts` |
| Trade | PASS | `player-trades.e2e-spec.ts`, `agent-domain-events`, `stage11-integration` |
| Marketplace | PASS | `player-marketplace.e2e-spec.ts`, `agent-domain-events` (custody, settlement, release) |
| VIP CHARACTER delivery | PASS | `agent-domain-events` (SYSTEM:VIP_DELIVERY, revoke antes/depois do command) |
| Player server discovery | PASS | `electron-integration`, `stage11-integration` |
| Player realtime recovery | PASS | `electron-integration`; offline → GET sem replay e cold start em `stage11-integration` |
| Staff realtime recovery | PASS | `stage11-integration` (reconnect sem replay, restart real, cold start por HTTP) |
| Electron contract | PASS | `docs/electron-integration.md` + `electron-integration` + cold start em `stage11-integration` |
| Admin Web contract | PASS | `docs/admin-web-integration.md` + `stage11-integration` |

### 25.3 O que fica para a Etapa 12

Multi-instância (roteamento de sockets do Agent, bus realtime distribuído,
workers coordenados), backpressure avançado, métricas exportadas (UNCERTAIN,
work pendente), timeout/ação de operador para Trade/Marketplace AWAITING e
releases, retry de delivery VIP por operador, deployment e hardening.
