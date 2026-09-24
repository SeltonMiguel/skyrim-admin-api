# Server Control (Etapa 09)

Solicitações operacionais de ciclo de vida do servidor — iniciar, pausar e
reiniciar — direcionadas a um futuro Agent de infraestrutura. Esta etapa entrega a
fronteira HTTP, a persistência, o Audit e o contrato do gateway. Não há transporte
real: em produção o gateway é `DisconnectedServerControlGateway`.

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
| `PENDING` | persistida; ainda não entregue ao transporte |
| `DISPATCHED` | o transporte aceitou, ou a entrega não pôde ser descartada (erro/timeout ambíguo) |
| `FAILED` | comprovadamente não entregue: `AGENT_UNAVAILABLE`, `AGENT_REJECTED` ou `SERVER_DISABLED` |
| `SUCCEEDED` | reservado para o receptor de resultados do Agent (Etapa 11); inalcançável hoje |

Transições: `PENDING → DISPATCHED`, `PENDING → FAILED` e, no futuro,
`DISPATCHED → SUCCEEDED | FAILED`. Checks no banco garantem coerência entre status,
`dispatched_at`, `completed_at` e `error_code`.

`ACKNOWLEDGED` e `TIMEOUT` do GameCommand foram deliberadamente omitidos: não há
receptor de ACK nem prazos de execução sem um protocolo de Agent. Serão
adicionados por migration incremental se a Etapa 11 os definir, em vez de criar
estados que o backend não sabe produzir.

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

O dispatch ocorre somente após o commit e somente para a request que criou a
operação:

1. Claim por um único `UPDATE` autocommit (`status = PENDING`,
   `dispatch_claimed_at IS NULL`, servidor habilitado). Se o servidor foi
   desabilitado nesse intervalo, a operação vai para `FAILED/SERVER_DISABLED`.
2. `ServerControlGateway.send(request, signal)` sem transação ou lock abertos,
   limitado a 1 s com abort.
3. Resultado gravado com cerca `status = PENDING`.

Contrato (`src/server-control/server-control-gateway.ts`):

```ts
interface ServerControlRequest {
  operationId: string;
  gameServerId: string;
  type: 'SERVER_START' | 'SERVER_PAUSE' | 'SERVER_RESTART';
  correlationId: string;
  requestedAt: string; // ISO-8601
}
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

`ServerControlDispatcher.dispatchPending()` recupera apenas operações sem claim
(queda entre commit e dispatch). Não há scheduler nesta etapa, assim como no Game
Bridge. Uma operação com claim e sem resultado (queda durante o envio) permanece
`PENDING`; a reconciliação fica para a Etapa 11.

O transporte (WebSocket, HTTP, gRPC ou outro) não está decidido. O backend não
depende de Electron, não usa `child_process`, shell, Docker, systemd ou Kubernetes;
um teste unitário verifica isso no código de `src/server-control/` e no
`package.json`.

## Comportamento sem Agent

Com `DisconnectedServerControlGateway` (padrão em produção), toda solicitação
aceita recebe 202 e termina em `FAILED` com `errorCode = AGENT_UNAVAILABLE` e
`errorMessage = "No server control Agent connected"`. Nunca há sucesso simulado.
Para tentar novamente, envie uma nova solicitação com nova Idempotency-Key.

## Estado real x inferido

O único estado de servidor que o backend conhece de fato é `game_servers.enabled`.
Servidor desabilitado → 409 para as três operações, inclusive replays.

A conexão do Game Bridge (heartbeat, `ONLINE/STALE/OFFLINE`) indica apenas se o
plugin dentro do jogo está falando com o backend. Ela não prova que o processo
está rodando, parado ou pausado, e por isso não é usada para aceitar ou rejeitar
START/PAUSE/RESTART. Regras como "START em servidor já rodando → 409" dependem de
estado reportado pelo Agent e ficam para a Etapa 11.

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

## Pendências

- Transporte real do Agent, receptor de resultado/ACK e estados adicionais
  (Etapa 11).
- Worker agendado para `dispatchPending()` e reconciliação de claims sem resultado.
- Regras de conflito baseadas em estado reportado pelo Agent e política para
  operações concorrentes no mesmo servidor.
- Configuration, conforme a seção anterior.
