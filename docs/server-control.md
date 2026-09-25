# Server Control (Etapa 09)

Solicitações operacionais de ciclo de vida do servidor — iniciar, pausar e
reiniciar — executadas pelo Host Agent. A Etapa 09 entregou a fronteira HTTP, a
persistência, o Audit e o contrato do gateway; a **Subetapa 11.3** liga o
transporte real (`AgentServerControlGateway`), o estado `UNCERTAIN`, os prazos e o
worker, com garantia **at-most-once**. O contrato do protocolo está em
`docs/integration-architecture.md` §9.1.

## Server Control não é GameCommand

| | GameCommand (Etapas 03–07) | Server Control (Etapa 09) |
| --- | --- | --- |
| Destino | Bridge/SKSE dentro do Skyrim em execução | Agent/infra que supervisiona o processo |
| Tabela | `game_commands` / `game_command_results` | `server_control_operations` |
| Pipeline | `GameCommandBus` → `GameCommandDispatcher` → `GameGateway` | `ServerControlService` → `ServerControlDispatcher` → `ServerControlGateway` |
| Payload | JSON tipado por CommandType | nenhum; a rota fixa a operação |
| Reentrega | retries com lease e ACK | at-most-once, nunca reenviada |

`src/server-control/` não importa `GameCommandBus`, `GameCommandDispatcher` nem
`GameGateway`. Do `GameBridgeModule` usa somente o registro de servidores
(`GameServerService`, para 404/lock/`enabled`) e o `BridgeClock`. Os tipos
`SERVER_*` não existem em `COMMAND_TYPES`; `/game-commands/:id` e
`/world-operations/:id` retornam 404 para uma operação de Server Control, e
`/server-control-operations/:id` retorna 404 para um GameCommand.

## Operações e endpoints

| Rota | Tipo | Permission | Audit action |
| --- | --- | --- | --- |
| `POST /api/v1/game-servers/:serverId/control/start` | `SERVER_START` | `SERVER_START` | `SERVER_START_REQUESTED` |
| `POST /api/v1/game-servers/:serverId/control/pause` | `SERVER_PAUSE` | `SERVER_PAUSE` | `SERVER_PAUSE_REQUESTED` |
| `POST /api/v1/game-servers/:serverId/control/restart` | `SERVER_RESTART` | `SERVER_RESTART` | `SERVER_RESTART_REQUESTED` |
| `GET /api/v1/server-control-operations/:operationId` | — | a do tipo armazenado | — |
| `GET /api/v1/game-servers/:serverId/control/operations` (11.6) | — | ao menos uma das três; lista só os tipos do chamador | — |

**Recuperação e wake-up (11.6).** A lista por servidor (`status`, `type`, `page`,
`limit ≤ 100`, ordem `createdAt DESC, id DESC`, mesma projeção do detalhe) deixa o
Admin Web achar a operação em voo ou UNCERTAIN sem conhecer o id. Toda escrita
terminal (resultado do Agent, UNCERTAIN por deadline, FAILED antes da entrega)
publica, após o commit, `STAFF_SERVER_CONTROL_UPDATED`
`{ operationId, gameServerId, type, status, errorCode, completedAt }` só para
Staff com a permissão do tipo; ver `docs/admin-web-integration.md`.

- START solicita a inicialização; PAUSE, uma pausa operacional com semântica a
  cargo do Agent; RESTART, um reinício controlado. Nenhuma suposição de processo,
  SO, container ou sinal é feita aqui.
- Corpo vazio. Qualquer propriedade (`command`, `args`, `env`, `executablePath`,
  `type`, `requestedByStaffId`…) resulta em 400. Não existem `SERVER_EXECUTE`,
  `RAW_SERVER_COMMAND`, `SHELL_COMMAND`, `stop` ou rota genérica de execução.
- Os POSTs respondem `202 Accepted` com
  `Location: /api/v1/server-control-operations/{operationId}` e
  `{ operationId, gameServerId, type, status, correlationId, requestId, createdAt }`.
- O detalhe acrescenta `requestedByStaffId`, `dispatchedAt`, `completedAt`,
  `errorCode` e `errorMessage`. Nunca expõe o Idempotency-Key nem o claim interno
  de dispatch.

Erros: 400 (UUID, Idempotency-Key ou corpo inválido), 401 (anônimo),
403 (sem permission), 404 (servidor ou operação inexistente), 409 (servidor
desabilitado ou chave reutilizada para outra operação), 503 (Audit indisponível;
nada persistido).

## Permissions

As permissions `SERVER_START`, `SERVER_PAUSE` e `SERVER_RESTART` e os grants para
COORDINATOR e DEV existem desde a migration AuthRbac (Etapa 01); nenhuma
permission ou grant foi criado nesta etapa. GENERAL_CHIEF, ADMIN, MODERATOR e
SUPPORT recebem 403. Não há acesso por hierarquia.

O detalhe exige a permission do tipo armazenado, lida das grants atuais a cada
request. Quem não possui nenhuma das três recebe 403 antes da consulta, sem
revelar se o ID existe.

## Semântica do 202 e estados

202 significa apenas que a solicitação foi aceita, persistida e auditada. Nunca
significa que o servidor iniciou, pausou ou reiniciou.

| Status | Significado |
| --- | --- |
| `PENDING` | persistida; sem claim, nada foi enviado (com claim: queda entre claim e reconciliação, possivelmente entregue) |
| `DISPATCHED` | enviada uma vez ao Host Agent, ou a entrega não pôde ser descartada (erro/timeout ambíguo); nunca reenviada |
| `SUCCEEDED` | o Agent reportou o efeito pretendido |
| `FAILED` | definitivamente sem efeito: nunca entregue (`AGENT_UNAVAILABLE`, `AGENT_REJECTED`, `SERVER_DISABLED`, `DISPATCH_EXPIRED`) ou falha definitiva do Agent (`DELIVERY_EXPIRED`, `INVALID_PROCESS_STATE`, `EXECUTION_FAILED`) |
| `UNCERTAIN` | terminal: o backend não sabe se a ação executou (`RESULT_TIMEOUT`: sem resultado até o prazo; `OUTCOME_UNKNOWN`: o Agent não conseguiu provar). Nunca há retry automático |

Transições: `PENDING → FAILED` (antes do claim, ou com não-entrega provada),
`PENDING → DISPATCHED`, e `PENDING (com claim) | DISPATCHED → SUCCEEDED | FAILED |
UNCERTAIN`. Checks no banco garantem coerência entre status, claim, prazos,
`dispatched_at`, `completed_at` e `error_code`. Não existe `ACKNOWLEDGED`: o
protocolo não tem ACK de recepção (uma operação é enviada uma vez em qualquer caso).

O Admin distingue "falhou" (`FAILED`) de "não sabemos" (`UNCERTAIN`) pelo `status`
e pelo `errorCode`/`errorMessage` do detalhe; a incerteza não fica escondida em
metadata de Audit.

## Uma operação em voo por servidor (11.3)

No máximo uma operação `PENDING`/`DISPATCHED` por servidor: outra solicitação
recebe 409 `Another server control operation is in progress`; o replay da mesma
Idempotency-Key continua devolvendo a operação existente. A regra é checada sob o
lock de `game_servers` e garantida pelo índice parcial único
`server_control_operations_active_key`. `UNCERTAIN` é terminal e libera o
servidor para uma nova solicitação explícita.

## Idempotência e concorrência

- `Idempotency-Key` é obrigatório (1–128 caracteres `A-Za-z0-9._:-`), com escopo
  por servidor: `UNIQUE (game_server_id, idempotency_key)`.
- Mesma chave e mesma operação retornam a mesma operação e o mesmo
  `correlationId`, com um único Audit e sem novo dispatch, inclusive quando outra
  role autorizada repete a chamada (a atribuição original é preservada).
- Mesma chave com outra operação → 409. Mesma chave em outro servidor é outra
  operação.
- A concorrência é resolvida pelo PostgreSQL: lock `FOR UPDATE` da linha de
  `game_servers`, `INSERT … ON CONFLICT DO NOTHING` na constraint única e releitura.
  Não há mutex em memória. Oito requests simultâneas geram uma operação, um Audit
  e um envio.

## Audit e atomicidade

Operação e Audit são gravados na mesma transação. Se o Audit falhar, a operação é
revertida (503) e nada é enviado; um retry com a mesma chave é seguro.

`SUCCESS` significa que o backend aceitou e persistiu a solicitação.
`resourceType = SERVER_CONTROL`, `resourceId = operationId`, `statusCode = 202`.
Metadata é uma allowlist exata: `gameServerId`, `operationId`, `correlationId`,
`type`. Não entram Idempotency-Key, tokens, headers, corpo ou detalhes do gateway.
Um `FAILED` posterior (por exemplo, Agent indisponível) não altera o Audit.

## Dispatch e gateway abstrato

O dispatch ocorre após o commit (na request que criou a operação e depois pelo
`ServerControlWorker`):

1. `gateway.target(servidor, tipo)`: sessão ACTIVE com capability. Sem alvo, a
   operação continua PENDING **sem claim** (nada enviado).
2. Claim por um único `UPDATE` autocommit (`status = PENDING`,
   `dispatch_claimed_at IS NULL`, servidor habilitado) que grava a sessão alvo,
   `not_after` e `result_deadline_at`. **Esta é a fronteira de entrega**: depois
   dela a operação nunca é reenviada. Se o servidor foi desabilitado, a operação
   vai para `FAILED/SERVER_DISABLED`.
3. `ServerControlGateway.send(request, signal)` sem transação ou lock abertos,
   limitado a 1 s com abort, só para a sessão do claim.
4. Resultado do send gravado com cerca `status = PENDING` (um RESULT que já chegou
   vence).

Contrato (`src/server-control/server-control-gateway.ts`):

```ts
interface ServerControlRequest {
  operationId: string;
  gameServerId: string;
  connectionId: string; // sessão fixada no claim (11.3)
  type: 'SERVER_START' | 'SERVER_PAUSE' | 'SERVER_RESTART';
  correlationId: string;
  requestedAt: string; // ISO-8601
  issuedAt: string; // claim (11.3)
  notAfter: string; // o Agent não executa depois disso (11.3)
}
// ServerControlGateway.target(gameServerId, type): string | null (11.3)
type ServerControlAcceptance =
  | { accepted: true }
  | { accepted: false; reason: 'UNAVAILABLE' | 'REJECTED' };
```

O request não contém texto de comando, argumentos, caminhos, variáveis de ambiente
ou credenciais: o Agent mapeia o tipo fechado para sua própria ação supervisionada.
`UNAVAILABLE`/`REJECTED` só podem ser retornados quando a entrega comprovadamente
não aconteceu; exceção ou timeout contam como possivelmente entregue
(`DISPATCHED`). A entrega é at-most-once: uma operação com claim nunca é reenviada,
porque repetir um RESTART é pior do que exigir uma nova solicitação explícita.

`ServerControlDispatcher.dispatchPending()` recupera apenas operações sem claim.
Desde a 11.3 o `ServerControlWorker` agenda isso e reconcilia os prazos: PENDING
sem claim além de `SERVER_CONTROL_PENDING_TIMEOUT_MS` → `FAILED/DISPATCH_EXPIRED`;
claim sem resultado além de `result_deadline_at` → `UNCERTAIN/RESULT_TIMEOUT`. Não
é um worker de retry.

O transporte é o WebSocket do Host Agent (`/api/v1/agent`, Etapa 11). O backend não
depende de Electron, não usa `child_process`, shell, Docker, systemd ou Kubernetes;
um teste unitário verifica isso no código de `src/server-control/` e no
`package.json`.

## Comportamento sem Agent

Sem Host Agent elegível (offline, sem `SERVER_CONTROL_V1` ou sem a capability da
ação), a solicitação recebe 202, fica `PENDING` sem claim e, se nenhum Agent
elegível conectar até `SERVER_CONTROL_PENDING_TIMEOUT_MS` (padrão 30 s), termina
`FAILED/DISPATCH_EXPIRED`: é seguro, porque nada foi enviado. Nunca há sucesso
simulado nem `UNCERTAIN` nesse caso. `DisconnectedServerControlGateway` continua
existindo como fallback de teste (nunca oferece alvo).

## Estado real x inferido

O único estado de servidor que o backend conhece de fato é `game_servers.enabled`.
Servidor desabilitado → 409 para as três operações, inclusive replays.

A conexão do Game Bridge (heartbeat, `ONLINE/STALE/OFFLINE`) indica apenas se o
plugin dentro do jogo está falando com o backend. Ela não prova que o processo
está rodando, parado ou pausado, e por isso não é usada para aceitar ou rejeitar
START/PAUSE/RESTART. Desde a 11.3 o Host Agent reporta `gameProcessState`/`skseReady`
(heartbeat e, opcionalmente, no `SERVER_CONTROL_RESULT`), mas o backend não recusa
por esse estado: o Agent responde `FAILED/INVALID_PROCESS_STATE` quando a ação não
se aplica. Regras de aceitação pelo estado reportado continuam decisão aberta.

## Configuration: pendente

Levantamento do modelo atual: `game_servers` possui apenas `id`, `code`, `name`,
`enabled`, `created_at` e `updated_at`. Não há endpoint de atualização de
GameServer, nem permission de configuração (o catálogo de 36 permissions não
contém `SERVER_CONFIG_*`), nem requisito de campos no repositório.

`code`/`name` são identificação de registro e `enabled` controla o gate do Game
Bridge; nenhum deles é configuração de servidor Skyrim. Expô-los como
"configuration" ou criar campos (portas, mods, caminhos, argumentos, env,
segredos) seria inventar schema. Por isso esta metade da etapa **não foi
implementada** e requer definição futura de:

- quais campos são administráveis e sua validação;
- permission dedicada e roles;
- se a configuração é do backend ou reportada/aplicada pelo Agent;
- controle de concorrência (por exemplo, versão/`updated_at` otimista).

Quando definida, deve seguir o padrão: DTO allowlist (nunca
`PATCH { chave: valor }` genérico), Audit atômico nas mutations e nenhum segredo,
caminho executável, argumento de shell ou variável de ambiente arbitrária.

## Migration

`1789880000000-ServerControl` cria somente `server_control_operations` com FKs
para `game_servers` e `staff_users`, unicidade de idempotência e `correlationId`,
checks de tipo/status/timestamps/erro e índices `(status, created_at)`,
`(game_server_id, created_at)` e `(request_id)`. Não altera permissions, grants
ou migrations anteriores. `down` remove a tabela, com perda do histórico de
operações. Totais: nove migrations, 36 permissions, 93 grants.

A Subetapa 11.3 adiciona `1790030000000-ServerControlTransport` (status
`UNCERTAIN`, claim/prazos, uma operação em voo por servidor); detalhes em
`src/database/migrations/README.md`.

## Pendências

- Regras de aceitação baseadas no estado de processo reportado (hoje o Agent
  recusa com `INVALID_PROCESS_STATE`).
- Métrica exportada de `UNCERTAIN` e lista de operações incertas no Admin Web.
- Configuration, conforme a seção anterior.
