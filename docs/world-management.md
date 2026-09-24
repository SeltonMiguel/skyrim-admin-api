# Etapa 07 — World Management

Quatro operações assíncronas usando a infraestrutura das Etapas 05–06. Skyrim
continua sendo a fonte de verdade. O backend armazena somente os GameCommands,
GameCommandResults e AuditLogs existentes, sem tabela/snapshot de estado World.

## Contratos e HTTP

Prefixo dos POSTs: `/api/v1/game-servers/:serverId/world/`. Todos exigem JWT,
permission explícita e `Idempotency-Key`. Cada endpoint fixa seu CommandType;
o cliente não escolhe um tipo arbitrário.

| CommandType | Body HTTP | Payload do command | Result de SUCCEEDED | Sufixo POST | Permission |
| --- | --- | --- | --- | --- | --- |
| WORLD_STATE_QUERY | `{}` | `{}` | `{ gameHour, weatherId }` | `state/query` | WORLD_READ |
| WORLD_TIME_SET | `{ gameHour }` | `{ gameHour }` | `{ gameHour }` | `time` | WORLD_TIME_WRITE |
| WORLD_WEATHER_SET | `{ weatherId }` | `{ weatherId }` | `{ weatherId }` | `weather` | WORLD_WEATHER_WRITE |
| WORLD_ENTITY_SPAWN | `{ baseFormId, quantity }` | `{ actorStaffId, baseFormId, quantity }` | `{ actorStaffId, baseFormId, requestedQuantity, spawnedQuantity }` | `spawn` | WORLD_ENTITY_SPAWN |

`gameHour` é número finito em **[0, 24)**, incluindo frações. Time usa SET explícito,
sem incremento, decremento, toggle ou timescale. Result do SET deve confirmar a
mesma hora solicitada; a query pode informar qualquer hora válida.

`weatherId` e `baseFormId` são strings opacas, trimadas, não vazias, com até
**128 unidades UTF-16**, Unicode válido e sem controles C0/C1. Não se assume
FormID, EditorID ou catálogo conhecido. IDs nunca são concatenados em comandos
textuais. `weatherId` pode ser **null somente no result da query**, para representar
a ausência de um identificador informado. Result de weather SET confirma o mesmo
ID normalizado solicitado.

`quantity` é inteiro entre **1 e 10**, limite conservador por solicitação para
conter a quantidade de entidades criadas em uma única operação. Spawn ocorre
junto ao staff autenticado no mundo. O serviço injeta `actorStaffId` (UUID de
`auth.user.id`) após validar um input fechado contendo apenas baseFormId/quantity.
Mesmo actorStaffId igual ao autenticado, quando enviado pelo cliente, é rejeitado.
A fronteira do serviço também rejeita essa tentativa. Não há coordenadas, cell,
worldspace, staff alternativo ou outro alvo aceito. A associação entre staff
administrativo e entidade no Skyrim fica para o adapter real, fora desta etapa.

Result de spawn deve confirmar actorStaffId, baseFormId e requestedQuantity do
pedido persistido. `spawnedQuantity` é inteiro entre **0 e requestedQuantity**:
aceita resultado parcial ou zero sem inventar entidades criadas. SUCCEEDED indica
resposta válida do bridge; o consumidor deve consultar as duas quantidades para
avaliar atendimento integral. Falha remota usa BRIDGE_ERROR; FAILED/TIMEOUT têm
result body null. RESULT inválido não conclui o command nem grava GameCommandResult.

Todos os schemas runtime são fechados, sem coercão de strings em números ou campos
extras. O validador compartilhado rejeita JSON hostil (getters, toJSON, funções,
ciclos, objetos de classe, undefined, Unicode inválido) e mantém os limites de
**4096 bytes por payload / 65536 por result**, incluindo o tamanho de jsonb::text.
Os controllers copiam DTOs para objetos JSON simples antes da submissão.

POST retorna **202 Accepted** e `Location: /api/v1/world-operations/{commandId}`.
A referência contém commandId, gameServerId, type, status, correlationId, requestId,
createdAt, sem payload/result. 202 significa solicitação aceita e persistida;
não significa execução confirmada no Skyrim, mesmo quando o replay já é terminal.

`GET /api/v1/world-operations/:commandId` consulta o CommandType persistido e exige
dinamicamente a permission da tabela. Expõe payload/result tipados, autoria,
tentativas, deadlines e timestamps. A leitura é por permission, sem restringir ao
criador. Outro domínio ou ID inexistente retorna 404; UUID malformado, 400;
sem autenticação, 401; sem permission atual, 403. Revogar o grant invalida o acesso
mesmo com o JWT já emitido. WORLD_READ não dá acesso ao detalhe de mutations.

## Matriz de permissions

| Role | WORLD_READ | WORLD_TIME_WRITE | WORLD_WEATHER_WRITE | WORLD_ENTITY_SPAWN |
| --- | --- | --- | --- | --- |
| COORDINATOR | Sim | Sim | Sim | Sim |
| GENERAL_CHIEF | Sim | Sim | Sim | Sim |
| ADMIN | Sim | Não | Não | Não |
| MODERATOR | Não | Não | Não | Não |
| SUPPORT | Não | Não | Não | Não |
| DEV | Não | Não | Não | Não |

A policy de domínio utiliza permissions, sem checks de role em produção. Os
testes HTTP validam POST e detalhe das quatro operações para as seis roles com
matriz esperada independente dos grants de produção.

## Idempotência, Audit e dispatch

`Idempotency-Key`: 1–128 caracteres ASCII alfanuméricos ou `._:-`, sem normalização
da chave. Escopo UNIQUE(game_server_id, idempotency_key), compartilhado entre
tipos. Payload normalizado e type iguais recuperam o mesmo commandId/correlationId
e preservam requestId/staff originais; outro payload/type retorna 409. Chaves iguais
em servidores diferentes são independentes. No spawn, actorStaffId integra o
payload: outro staff usando a mesma chave/servidor recebe 409.

`AdministrativeCommandService` verifica a permission, copia payload/autoria e abre
a transação curta existente. Com lock do servidor, verifica enabled e chama
`submitInTransaction`; se o command é novo e é mutation, AuditService usa o mesmo
EntityManager. Command + Audit são confirmados atomicamente. Falha de Audit gera
503 e rollback do command; a mesma chave pode ser repetida após recuperação.
Query não gera Audit, inclusive se a gravação de Audit estiver indisponível.

As três actions são WORLD_TIME_SET_REQUESTED, WORLD_WEATHER_SET_REQUESTED e
WORLD_ENTITY_SPAWN_REQUESTED. ResourceType=WORLD, resourceId=commandId, statusCode=202.
Audit SUCCESS registra **aceitação/persistência**, permanece SUCCESS quando a
execução falha ou expira. Actor e requestedByStaffId vêm da autenticação.

Allowlist de metadata:

| Mutation | Campos comuns | Campos específicos |
| --- | --- | --- |
| WORLD_TIME_SET | gameServerId, commandId, correlationId | gameHour |
| WORLD_WEATHER_SET | gameServerId, commandId, correlationId | weatherId |
| WORLD_ENTITY_SPAWN | gameServerId, commandId, correlationId | actorStaffId, baseFormId, quantity |

Não são copiados objetos payload/result, Idempotency-Key, tokens ou lease. Os
campos específicos são selecionados individualmente no builder de Audit.

O POST apenas enfileira. O dispatcher existente lê trabalho confirmado, reserva
uma tentativa em transação curta, confirma e chama `gateway.send()` fora de
transação/row locks. Reconciliação usa outra transação curta. Retry HTTP, inclusive
concorrente e após conclusão, não cria Command, Audit ou dispatch adicional.

Os testes verificam oito requests simultâneos por tipo → um Command, um Audit
somente para mutation; conflitos concorrentes → 202/409; falha real de constraint
Audit → rollback; visibilidade de Command/Audit em outra conexão antes do send;
locks NOWAIT durante send e RESULT recebido durante o I/O do gateway.
Lifecycle/retry/lease/ACK/timeout da Etapa 03 não foram alterados. A entrega remota
continua at-least-once: um adapter real deve deduplicar comandos no destino.

## Redaction, servidor e persistência

`GET /api/v1/game-commands/:id` permanece operacional, autorizado por
GAME_BRIDGE_READ. Não expõe payload, gameHour/weatherId, baseFormId/quantity,
actorStaffId do payload, result body, chave idempotente, lease ou ownership.
Result genérico contém apenas outcome, errorCode e receivedAt. Support/DEV podem
ler essa metadata sem acessar o detalhe World. Não foi alterado o presenter genérico.

Servidor inexistente=404; disabled=409 sem novo Command/Audit, inclusive replay;
enabled offline/stale=202/PENDING. Não há execução simulada. O adapter padrão
continua DisconnectedGameGateway; dispatch permanece explícito, sem scheduler.

Migration incremental **1789860000000-WorldPermissions** adiciona somente **4
permissions e 9 grants**, levando o banco a **35 permissions, 92 grants e 7
migrations**. É necessária para persistir a matriz de acesso; não altera estrutura
ou migrations anteriores. Down remove apenas permissions/grants World; testes de
rollback confirmam preservação das 31 permissions e 83 grants anteriores. O schema
continua com synchronize=false e sem tabelas World.

Fora do escopo: despawn/delete, NPC AI/control, quests, cells/worldspaces,
coordenadas, teleport, timescale, globals, catálogos locais, snapshots, schedulers,
Agent/SKSE real e frontend. Decisões para revisão: limite de 10 por spawn,
resultado parcial/zero explícito, SET confirma valor solicitado, IDs opacos até
128 unidades UTF-16 e detalhes acessíveis por permission sem ownership por staff.

## Validação

- `npm run lint`
- `npm run build`
- `npm test`
- `TEST_DATABASE_INTEGRATION=true npm run test:e2e`
- `npm run migration:run`
- `git diff --check`
- `npx tsc --noEmit --incremental false`

A integração requer PostgreSQL real e usa schemas isolados. Rodar sem
TEST_DATABASE_INTEGRATION=true omite intencionalmente suites de banco; isso não
substitui a validação desta etapa. A bateria inclui regressões de Character e
Moderation, rollback/reaplicação de migrations e ausência de schema diff.

Validação concluída nesta implementação: lint/build/tsc/diff-check aprovados,
356 testes unitários (20 suites) e 396 e2e (9 suites) aprovados, incluindo 46
unitários e 35 e2e World; zero skips. Migration aplicada no banco local, nenhuma
pendente, synchronize=false, schema diff vazio nas duas direções e migrations
anteriores intactas.
