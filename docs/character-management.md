# Etapa 05 — Character Management

A API aceita operações administrativas assíncronas. Skyrim continua sendo a fonte
de verdade: a persistência desta etapa usa GameCommand, GameCommandResult e
AuditLog, sem tabelas de snapshots de personagens. BRIDGE_PING continua disponível
internamente. Não há Agent/SKSE real, scheduler, execução arbitrária ou Etapa 06.

## Contratos, endpoints e permissions

Todos os POSTs usam o prefixo
`/api/v1/game-servers/:serverId/characters/:characterId/`, JWT e
`Idempotency-Key`. O servidor é UUID; characterId e IDs de alvos são strings opacas.
O endpoint determina um CommandType fixo. O body HTTP contém apenas os campos da
coluna Payload além de characterId, que vem da rota. Queries recebem `{}`.

Notação dos contratos (não são campos adicionais no JSON):

- `C = { characterId: string }`.
- `M = { characterId: string, applied: true, targetId: string }`.
- `Entry<K> = { [K]: string, displayName?: string }`.
- `C + {...}` significa um único objeto com todos esses campos.
- Result na tabela é o body de SUCCEEDED. FAILED/TIMEOUT persistem body null.

| CommandType | POST (sufixo) | Payload | Result | Permission do POST e do detalhe |
| --- | --- | --- | --- | --- |
| CHARACTER_INVENTORY_QUERY | inventory/query | C | C + { items: (Entry<itemId> + { quantity: number })[] } | CHARACTER_INVENTORY_READ |
| CHARACTER_INVENTORY_REMOVE_ITEM | inventory/items/remove | C + { itemId: string, quantity: number } | M | CHARACTER_INVENTORY_WRITE |
| CHARACTER_ITEM_GIVE | inventory/items/give | C + { itemId: string, quantity: number } | M | CHARACTER_ITEM_GIVE |
| CHARACTER_PROPERTIES_QUERY | properties/query | C | C + { properties: Entry<propertyId>[] } | CHARACTER_PROPERTY_READ |
| CHARACTER_PROPERTY_GRANT | properties/grant | C + { propertyId: string } | M | CHARACTER_PROPERTY_WRITE |
| CHARACTER_PROPERTY_REVOKE | properties/revoke | C + { propertyId: string } | M | CHARACTER_PROPERTY_WRITE |
| CHARACTER_HOLDS_QUERY | holds/query | C | C + { holds: Entry<holdId>[] } | CHARACTER_HOLD_READ |
| CHARACTER_HOLD_GRANT | holds/grant | C + { holdId: string } | M | CHARACTER_HOLD_WRITE |
| CHARACTER_HOLD_REVOKE | holds/revoke | C + { holdId: string } | M | CHARACTER_HOLD_WRITE |
| CHARACTER_HORSES_QUERY | horses/query | C | C + { horses: Entry<horseId>[] } | CHARACTER_HORSE_READ |
| CHARACTER_HORSE_GIVE | horses/give | C + { horseId: string } | M | CHARACTER_HORSE_GIVE |
| CHARACTER_HORSE_REVOKE | horses/revoke | C + { horseId: string } | M | CHARACTER_HORSE_WRITE |
| CHARACTER_TITLE_GIVE | titles/give | C + { titleId: string } | M | CHARACTER_TITLE_GIVE |
| CHARACTER_SPELL_GIVE | spells/give | C + { spellId: string } | M | CHARACTER_SPELL_GIVE |
| CHARACTER_FACTIONS_QUERY | factions/query | C | C + { factions: Entry<factionId>[] } | FACTION_READ |
| CHARACTER_FACTION_ADD | factions/add | C + { factionId: string } | M | FACTION_WRITE |
| CHARACTER_FACTION_REMOVE | factions/remove | C + { factionId: string } | M | FACTION_WRITE |

`GET /api/v1/character-operations/:commandId` exige a permission da linha
correspondente, consultada por CommandType; não compara roles. Non-character
commands e IDs inexistentes retornam 404. UUID malformado retorna 400.
Coordinator/General Chief têm os grants atuais; Admin/Moderator/Support/DEV recebem
403 em todos os POSTs e detalhes Character. Alterar um grant no banco afeta a
próxima requisição, inclusive com o mesmo JWT.

## Aceitação, detalhe e lifecycle

Todos os POSTs retornam **202 Accepted**, com
`Location: /api/v1/character-operations/{commandId}`. A referência contém
commandId, gameServerId, characterId, type, status, correlationId, requestId e
createdAt. 202 significa somente operação aceita e persistida; não significa
execução bem-sucedida no Skyrim. Um retry pode retornar o estado terminal atual
do mesmo command.

O detalhe acrescenta payload tipado, requestedByStaffId, dispatchAttempts,
lastDispatchAt, acknowledgedAt, completedAt, ackDeadlineAt, executionDeadlineAt e
result nullable. Result contém outcome, result tipado/null, errorCode,
errorMessage local controlada e receivedAt.

O lifecycle permanece PENDING → DISPATCHED → ACKNOWLEDGED →
SUCCEEDED/FAILED/TIMEOUT, com as transições de falha pré-entrega e inferência de ACK
já definidas no [protocolo](game-bridge-protocol.md). Servidor nonexistent retorna
404. Disabled retorna 409, inclusive no replay HTTP, sem criar Command/Audit.
Enabled offline/stale aceita PENDING/202 sem simular execução. Indisponibilidade
posterior segue retries/timeouts existentes.

## Validação runtime e limites

- Payload fechado por CommandType; campos extras e tipos arbitrários rejeitados.
  O body não pode sobrescrever characterId, servidor, type, requestId ou staff.
- IDs e displayName: trim, 1–128 unidades UTF-16, Unicode válido, sem controles
  C0/C1. Não se interpreta FormID, SteamID, UUID ou expressão executável nesses IDs.
- quantity: number inteiro de 1 a 10000, sem coerção de string.
- Arrays de result: até 512 entradas, com schemas fechados por coleção.
- Payload: **4096 bytes**. Result: **65536 bytes**. A verificação inclui os espaços
  estruturais da representação PostgreSQL `jsonb::text`, além do JSON serializado.
- JSON rejeita getters, toJSON, símbolos, funções, undefined, números não finitos,
  ciclos, arrays esparsos e profundidade acima de 32.
- O receiver seleciona o validador pelo type do command persistido, confere
  characterId e, em mutations, targetId contra o alvo do payload. SUCCEEDED de
  mutation exige applied=true. Os 12 tipos de mutation compartilham esse formato.
- Query não aceita result de outra coleção nem objeto arbitrário. Result inválido
  não é persistido e não converte o command para SUCCEEDED.
- Resultado duplicado equivalente é idempotente; resultado terminal conflitante
  retorna conflito. FAILED de Character aceita BRIDGE_ERROR; mensagem remota não
  é persistida. PING_REJECTED pertence somente a BRIDGE_PING.

## Idempotência, auditoria e atomicidade

Idempotency-Key é obrigatório: 1–128 caracteres ASCII alfanuméricos ou `._:-`,
sem trim da chave. Escopo UNIQUE(game_server_id, idempotency_key), compartilhado
entre os tipos. A comparação usa type + payload validado/canônico: ordem de chaves
não importa e IDs opacos são normalizados. Outro payload/type/character com a
mesma chave/servidor retorna 409; outro servidor possui escopo independente.

O primeiro POST cria exatamente um GameCommand. Uma mutation cria exatamente um
AuditLog; as cinco queries não criam AuditLog. Retry equivalente retorna os mesmos
commandId/correlationId, preserva autoria/requestId originais, não cria audit e
não dispara send nem nova criação lógica. Não há mutex em memória: locks e a
constraint UNIQUE no PostgreSQL são a garantia compartilhada entre processos.

Fluxo de criação:

1. Autenticar, conferir permission, validar e copiar payload/autoria.
2. Abrir transação curta; bloquear GameServer e verificar enabled.
3. INSERT ON CONFLICT ON CONSTRAINT game_commands_idempotency_key DO NOTHING;
   ler command e comparar type/payload. O UUID proposto indica se houve criação.
4. Somente para mutation nova, `AuditService.record(..., manager)` usa o mesmo
   EntityManager/transação que inseriu GameCommand.
5. Commit de Command + Audit; então retornar a referência HTTP.

Falha de INSERT do Audit lança 503 e provoca rollback do novo GameCommand. Nenhuma
mutation HTTP é aceita sem audit. A chave fica disponível para retry posterior.
Audit SUCCESS significa **ACCEPTED/REQUESTED pelo backend**, mesmo se o bridge
posteriormente falhar ou expirar. Não é sucesso de execução no Skyrim.

AuditActions explícitas:

- CHARACTER_INVENTORY_ITEM_REMOVE_REQUESTED
- CHARACTER_ITEM_GIVE_REQUESTED
- CHARACTER_PROPERTY_GRANT_REQUESTED
- CHARACTER_PROPERTY_REVOKE_REQUESTED
- CHARACTER_HOLD_GRANT_REQUESTED
- CHARACTER_HOLD_REVOKE_REQUESTED
- CHARACTER_HORSE_GIVE_REQUESTED
- CHARACTER_HORSE_REVOKE_REQUESTED
- CHARACTER_TITLE_GIVE_REQUESTED
- CHARACTER_SPELL_GIVE_REQUESTED
- CHARACTER_FACTION_ADD_REQUESTED
- CHARACTER_FACTION_REMOVE_REQUESTED

ResourceType é CHARACTER; resourceId é characterId. Metadata usa allowlist:
gameServerId, commandId, correlationId, characterId, operation, targetId e quantity
quando aplicável. Não inclui payload inteiro, result, Idempotency-Key,
Authorization/JWT, headers completos, lease token ou segredos. Autoria e contexto
HTTP seguem AuditService. Audit continua append-only e sua consulta exige AUDIT_READ.

## Dispatch depois do commit

O POST apenas enfileira. O dispatcher da Etapa 03 é chamado explicitamente;
não há scheduler novo. A leitura do dispatcher só vê GameCommand após o commit,
que já inclui Audit para mutation.

`reserve()` faz sua própria transação curta, persiste lease/deadlines e faz commit.
Depois, `await GameGateway.send(...)` ocorre sem transação/row lock aberto.
Uma terceira transação reconcilia o transporte pelo token da reserva. ACK/RESULT
pode chegar durante send. Retry HTTP não participa do retry de transporte.

Os testes PostgreSQL verificam Command e Audit visíveis durante send, aquisição
de locks de servidor/command por conexão separada com FOR UPDATE NOWAIT, ausência
de transação de reserva ociosa e RESULT durante send sem perder o terminal.

## API genérica exclusivamente operacional

`GET /api/v1/game-commands/:id` exige GAME_BRIDGE_READ e vale igualmente para os
17 tipos Character e BRIDGE_PING. Consulta/presenter usam allowlists. Retorna id,
gameServerId, type, status, correlationId, requestId, requestedByStaffId,
dispatchAttempts, lastDispatchAt, acknowledgedAt, completedAt, createdAt,
ackDeadlineAt, executionDeadlineAt e result nullable com apenas outcome,
errorCode e receivedAt.

Oculta payload, result body, errorMessage, characterId derivado, itemId, inventory,
propertyId, holdId, horseId, factionId, titleId, spellId, targetId, idempotencyKey,
dispatchLeaseId, dispatchLeaseExpiresAt e dispatchedConnectionId/ownership interno.
Support/DEV podem ler esses metadados operacionais, mas recebem 403 no detalhe
Character. Conteúdo de domínio está exclusivamente no endpoint Character.

## Migration e decisões para revisão

`1789850000000-CharacterResultLimit.ts` é a única migration desta etapa. `up`
substitui game_command_results_size_check para aceitar NULL ou objeto JSONB de
até 65536 bytes. Payload permanece em 4096. `down` restaura 4096; se já houver
resultados maiores, o downgrade falha atomicamente sem apagar/truncar dados e
preserva o check/histórico de 65536. As cinco migrations anteriores permanecem
intactas. A entidade GameCommandResult coincide com o check novo.

Decisões mantidas para revisão antes do commit:

- Criação HTTP somente enfileira; integração real e agendamento continuam fora
  desta etapa. O transporte padrão é DisconnectedGameGateway.
- Respostas de mutation compartilham `{ characterId, applied: true, targetId }`;
  não reportam quantidade aplicada nem snapshot posterior.
- Result limitado a 512 entradas/64 KiB, sem paginação automática de inventário.
- Replay Character com servidor disabled retorna 409. O bus interno mantém sua
  política anterior de recuperar replay técnico equivalente após disable.
- Locks curtos por servidor serializam submissões; UNIQUE é a proteção final.
- O teto SQL de result é comum à tabela; BRIDGE_PING continua limitado pelo schema
  de nonce curto. Um downgrade com results grandes exige decisão operacional.
- Remoção de payload/result body do endpoint genérico é uma mudança de contrato
  deliberada; consumidores autorizados usam character-operations.
- Transporte mantém semântica at-least-once, sem promessa de exactly-once remoto.
  O futuro Agent deve deduplicar; não há execução remota real nesta entrega.
