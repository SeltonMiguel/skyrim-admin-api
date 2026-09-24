# Etapa 06 — Moderation

Oito operações administrativas assíncronas, sem execução arbitrária. Skyrim
continua sendo a fonte de verdade. Não há persistência local de bans, god mode,
noclip, invisibility, teleports ou announcements; somente GameCommand,
GameCommandResult e AuditLog existentes.

## Contratos e endpoints

Prefixo de todos os POSTs:
`/api/v1/game-servers/:serverId/moderation/`.
Todas as rotas exigem JWT, permission da tabela e header `Idempotency-Key`.
As propriedades na tabela são os campos JSON efetivos; IDs/textos são strings,
`enabled` é boolean. Payload inclui IDs derivados da rota/autenticação, que não
fazem parte do body HTTP. Result é o body de SUCCEEDED; FAILED/TIMEOUT têm body null.

| CommandType | Payload | Result | Sufixo POST | Permission do POST e detalhe |
| --- | --- | --- | --- | --- |
| PLAYER_BAN | { playerId, reason? } | { playerId, banned: true } | players/:playerId/ban | PLAYER_BAN |
| PLAYER_UNBAN | { playerId, reason? } | { playerId, banned: false } | players/:playerId/unban | PLAYER_UNBAN |
| PLAYER_GOD_MODE_SET | { playerId, enabled } | { playerId, enabled } | players/:playerId/god-mode | PLAYER_GOD_MODE |
| STAFF_NOCLIP_SET | { actorStaffId, enabled } | { actorStaffId, enabled } | staff/me/noclip | STAFF_NOCLIP |
| STAFF_INVISIBILITY_SET | { actorStaffId, enabled } | { actorStaffId, enabled } | staff/me/invisibility | STAFF_INVISIBILITY |
| ANNOUNCEMENT_SEND | { message } | { sent: true } | announcements | ANNOUNCEMENT_SEND |
| STAFF_TELEPORT_TO_PLAYER | { actorStaffId, targetPlayerId } | { actorStaffId, targetPlayerId, teleported: true } | staff/me/teleport-to-player | STAFF_TELEPORT_TO_PLAYER |
| PLAYER_TELEPORT_TO_STAFF | { actorStaffId, targetPlayerId } | { actorStaffId, targetPlayerId, teleported: true } | players/:playerId/teleport-to-me | PLAYER_TELEPORT_TO_STAFF |

Bodies HTTP: `{ reason? }` para ban/unban; `{ enabled }` para os três SET;
`{ message }` para announcement; `{ targetPlayerId }` para staff→player; `{}` para
player→staff (targetPlayerId vem de playerId da rota).
`actorStaffId` é sempre o UUID do staff autenticado, injetado pelo serviço nas
quatro operações de staff/teleporte. Body com staffId/actorStaffId é rejeitado.
O serviço também rejeita tentativa interna de fornecer actorStaffId na submission.
`requestedByStaffId` e autoria de Audit vêm igualmente da autenticação.

Todos os POSTs retornam **202 Accepted** e
`Location: /api/v1/moderation-operations/{commandId}`. Referência contém commandId,
gameServerId, type, status, correlationId, requestId e createdAt. Não expõe payload.
202 significa apenas solicitação aceita e persistida, nunca sucesso do Skyrim.

`GET /api/v1/moderation-operations/:commandId` deriva a permission do CommandType
persistido. Expõe referência, payload/result tipados, autoria, tentativas,
deadlines e timestamps. Command de Character/BRIDGE_PING ou inexistente retorna
404. UUID malformado retorna 400. Sem autenticação retorna 401; sem permission,
403. A leitura é por permission, sem restringir o detalhe ao staff criador.

## Matriz validada

| Role | Ban / unban / god mode | Noclip / invisibility / announcement / staff→player | Player→staff |
| --- | --- | --- | --- |
| COORDINATOR | Sim | Sim | Sim |
| GENERAL_CHIEF | Sim | Sim | Sim |
| ADMIN | Sim | Sim | Sim |
| MODERATOR | Não | Sim | Sim |
| SUPPORT | Não | Não | Sim |
| DEV | Não | Não | Não |

São usadas exclusivamente as permissions/grants existentes. Nenhum check de role
no código de produção de Moderation. Os testes HTTP exercitam as oito operações e
seus detalhes para as seis roles, com matriz esperada independente da policy.
Support recebe 403 no detalhe PLAYER_BAN e 200 em PLAYER_TELEPORT_TO_STAFF.
Remover esse grant no banco passa a gerar 403 com o mesmo JWT; metadata genérica
via GAME_BRIDGE_READ continua acessível.

## Validação runtime

Schemas fechados por CommandType, sem tipo escolhido pelo cliente, raw command,
script, toggle, staffId, atribuição forjada ou campos extras. IDs de player são
opacos, trimados, não vazios, com até 128 unidades UTF-16, Unicode válido e sem
controles C0/C1. UUID é exigido para serverId, commandId e actorStaffId.

God mode/noclip/invisibility usam SET com true ou false, nunca toggle. Strings
"true"/"false", números, null e ausência de enabled são rejeitados.
Reason é opcional; quando presente, texto trimado de 1–500 unidades UTF-16.
Announcement exige texto trimado de 1–500 unidades UTF-16. Textos são literais,
sem interpretação de HTML/Markdown/console/script; controles e Unicode malformado
são rejeitados (inclusive quebras de linha). Caracteres como `<`/`>` permanecem
texto; um consumidor visual futuro deve renderizar como texto.

Limites preservados: **payload 4096 bytes**, **result 65536 bytes**, incluindo os
espaços estruturais de `jsonb::text`. O validador comum rejeita getters, toJSON,
objetos de classe, funções, símbolos, undefined, ciclos, arrays esparsos e JSON
acima de 32 níveis. Controllers copiam DTOs para objetos simples e omitem reason
ausente antes de validar o contrato.

O receiver usa o type e payload persistidos para validar o RESULT. Player/staff/
alvo e enabled devem corresponder ao pedido; ban exige banned=true, unban=false,
announcement exige sent=true e teleports exigem teleported=true. Campo extra,
objeto arbitrário, valor oposto ou identidade diferente é rejeitado sem persistir
body ou transformar o command em SUCCEEDED. Formatos iguais entre noclip e
invisibility, ou entre direções de teleport, são compartilhados deliberadamente;
a identidade da operação vem do commandId/correlationId/type persistidos.

Falha remota usa BRIDGE_ERROR e mensagem local controlada, sem stack/message
arbitrário. PING_REJECTED continua exclusivo de BRIDGE_PING. Result duplicado
válido permanece idempotente; resultado terminal conflitante não sobrescreve o
primeiro. Lifecycle/retry/lease da Etapa 03 não foram alterados.

## Idempotência e atomicidade

Idempotency-Key obrigatório: 1–128 caracteres ASCII alfanuméricos ou `._:-`, sem
normalização da chave. UNIQUE(game_server_id, idempotency_key) do PostgreSQL e
INSERT ON CONFLICT continuam sendo a autoridade, com locks curtos por servidor.
Escopo compartilhado entre todos os tipos; não há mutex em memória.

Type/payload canônicos equivalentes retornam o mesmo commandId/correlationId e
preservam requestId/staff originais. Ordem das chaves e espaços externos trimados
em IDs/textos não mudam a operação. Payload/type/player diferentes retornam 409.
Nas ações de staff, actorStaffId faz parte do payload: outra pessoa usando a mesma
chave/servidor recebe 409, não reutiliza uma ação vinculada a outro staff.

Character e Moderation reutilizam `AdministrativeCommandService`, extraído do
fluxo da Etapa 05, sem recriar bus, dispatcher ou receiver. Fluxo:

1. Policy de domínio, validação/cópia do payload e autoria autenticada.
2. Transação curta: lock do servidor, verificação enabled, submitInTransaction.
3. Se criou command novo, AuditService.record usa o mesmo EntityManager.
4. Commit confirma Command + Audit SUCCESS; só então a referência é retornada.
5. Dispatcher existente lê trabalho confirmado, reserva tentativa em outra
   transação curta, faz commit e chama gateway.send fora de transação/row locks.
   Reconciliação usa outra transação curta.

Falha de Audit gera 503 e rollback do novo command. Retry após recuperação é
seguro. Retry HTTP equivalente não cria command, audit ou dispatch adicional,
inclusive quando o command já é terminal. Queries Character continuam sem Audit.
Os testes verificam oito POSTs simultâneos por tipo → um Command e um Audit, dois
payloads concorrentes conflitantes → 202/409, rollback de Audit para os oito tipos,
locks NOWAIT de outra conexão durante send e RESULT antes da reconciliação.

## Audit e redaction

Todas as oito operações usam AuditAction explícita com sufixo `_REQUESTED`:
PLAYER_BAN_REQUESTED, PLAYER_UNBAN_REQUESTED, PLAYER_GOD_MODE_SET_REQUESTED,
STAFF_NOCLIP_SET_REQUESTED, STAFF_INVISIBILITY_SET_REQUESTED,
ANNOUNCEMENT_SEND_REQUESTED, STAFF_TELEPORT_TO_PLAYER_REQUESTED e
PLAYER_TELEPORT_TO_STAFF_REQUESTED.

ResourceType=MODERATION e resourceId=commandId. SUCCESS significa **backend
aceitou e persistiu a solicitação**; continua SUCCESS se a execução falhar/expirar.
Metadata contém somente gameServerId, commandId, correlationId e, quando
aplicáveis, playerId, actorStaffId, targetPlayerId, enabled. Reason, message,
payload/result completos, Idempotency-Key, tokens/headers e lease não entram em
Audit. Reason/message existem no GameCommand para entrega ao bridge e no detalhe
autorizado da operação; não são copiados para o AuditLog.

`GET /api/v1/game-commands/:id` permanece inalterado e exclusivamente operacional:
sem payload, playerId derivado, reason/message, enabled/targets, result body,
idempotencyKey, lease ou ownership. Result genérico tem apenas outcome/errorCode/
receivedAt. Support e DEV podem consultar essa metadata via GAME_BRIDGE_READ sem
obter o conteúdo Moderation. O catálogo/filtro genérico reconhece os oito tipos
novos automaticamente pelo COMMAND_TYPES compartilhado.

## Servidor, migrations e limites de escopo

UUID inválido=400; servidor inexistente=404; disabled=409 sem novo Command/Audit,
inclusive replay HTTP. Enabled offline/stale=202/PENDING sem simular sucesso.
POST apenas enfileira. Sem scheduler novo: chamadas do dispatcher permanecem
explícitas; DisconnectedGameGateway é o adapter padrão. Retries/ACK/RESULT/timeout
preservam o protocolo existente e a entrega remota at-least-once.

Nenhuma migration nova: não há mudança de schema, entidades, permissions ou
grants. Mantêm-se seis migrations, 31 permissions, 83 grants e synchronize=false.
Não existem tabelas locais de Moderation nem temporary bans, scheduler,
World Management, VIP Store, Server Control, Agent/SKSE real ou frontend realtime.

Decisões para revisão: reason limitado a 500 e textos de uma linha; result mínimo
sem conteúdo textual; SET exige confirmação do mesmo boolean; detalhes por
permission sem ownership por staff; resourceId do Audit é commandId; a associação
entre staff administrativo e entidade no Skyrim ficará a cargo do adapter real.
