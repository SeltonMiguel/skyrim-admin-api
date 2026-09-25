# Game Bridge — protocolo interno v1

Etapa 03. Contrato independente das entidades TypeORM, sem transporte de rede,
Agent/SKSE ou scheduler. A Etapa 05 adiciona endpoints de domínio e 17 comandos
Character tipados, documentados em [Character Management](character-management.md),
além de `BRIDGE_PING`. A Etapa 06 adiciona oito comandos de
[Moderation](moderation.md) e a Etapa 07 adiciona quatro de
[World Management](world-management.md). A Subetapa 10.5 adiciona
`CHARACTER_PROFILE_QUERY` e `CHARACTER_SKILLS_QUERY`, criados por players
([Player Services](player-services.md)), totalizando 32 tipos fechados. Não existe
interpretação de strings como console Skyrim, shell ou comandos do sistema.

## Serviços e configuração

- `GameServerService.register/get`: servidores identificados por UUID e code único.
- `GameConnectionService.connect/heartbeat/disconnect/active/isConnectionHealthy/markStaleConnections`.
- `GameCommandBus.submit`: cria ou recupera um comando idempotente.
- `GameCommandDispatcher.dispatch/dispatchPending/retryTimedOutDispatches`.
- `GameCommandReceiver.acknowledge/result/expireCommands`.

Métodos de varredura processam até 100 candidatos por chamada, revalidando cada
um sob lock. Não há timer de background; um orquestrador futuro deverá chamá-los.
Serviços não selecionam um servidor padrão. Registre servidores explicitamente.
O transporte não depende de Auth, RBAC ou Audit. CharacterService e
ModerationService e WorldService fornecem as policies de domínio ao AdministrativeCommandService,
extraído da Etapa 05. Ele usa `submitInTransaction` para confirmar Command e Audit
na mesma transação curta. Queries Character/World não são auditadas; todas as oito
operações Moderation e as três mutations World são auditadas. POST não dispara send;
o dispatcher só enxerga commands confirmados. Retry HTTP não dispara transporte.

| Variável | Padrão | Valores aceitos |
| --- | --- | --- |
| GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS | 30000 | inteiro 100–3600000 |
| GAME_COMMAND_ACK_TIMEOUT_MS | 5000 | inteiro 100–3600000 |
| GAME_COMMAND_EXECUTION_TIMEOUT_MS | 30000 | inteiro 100–86400000 |
| GAME_COMMAND_MAX_DISPATCH_ATTEMPTS | 3 | inteiro 1–10 |

Os relógios são injetados por `BridgeClock`. Datas persistidas são timestamptz;
o wire format usa ISO 8601 UTC. Os deadlines são avaliados após adquirir locks,
com `now >= deadline` considerado expirado. A reserva da primeira tentativa fixa um prazo total de execução: ACK e retries
não o estendem depois de uma entrega possível. Uma recusa comprovada enquanto
a primeira reserva ainda pertence ao remetente permite limpar esse prazo, pois
nenhuma entrega ocorreu. O prazo
de ACK de cada tentativa é limitado por esse prazo total. Logo, uma configuração
com execução menor que ACK faz o prazo total vencer primeiro.

## Conexão e heartbeat

`connect({ gameServerId, externalConnectionId, bridgeVersion?, protocolVersion? })`
aceita somente protocolVersion `"1"` (padrão). Retorna `GameConnection.id`, UUID
da sessão atribuída pelo backend. Esse UUID é o `connectionId` em todos os
mensagens/envelopes abaixo; externalConnectionId identifica a sessão no adapter.

Uma conexão nova fecha a anterior como DISCONNECTED/SUPERSEDED e cria CONNECTED
na mesma transação. O índice parcial UNIQUE garante uma ativa por servidor.
Repetir connect com o mesmo externalConnectionId ativo/saudável retorna a sessão;
reutilizar um ID encerrado/stale é rejeitado. IDs externos são únicos por servidor
em todo o histórico. Uma reconexão deve fornecer novo externalConnectionId.

Heartbeat conceitual: `{ protocolVersion: "1", serverId, connectionId }`.
O futuro adapter validará a versão antes de chamar `heartbeat(serverId, connectionId)`.
Heartbeat atualiza exclusivamente a sessão ativa correspondente. No limite de
staleness, fecha a conexão como STALE e retorna false; não ressuscita sessões.
`disconnect` registra REQUESTED; repetir retorna false. Não se apaga histórico.
Servidor disabled impede connect, heartbeat válido e novo dispatch.

## Command envelope

```json
{
  "protocolVersion": "1",
  "commandId": "019b4700-1111-4111-8111-111111111111",
  "correlationId": "019b4700-2222-4222-8222-222222222222",
  "serverId": "019b4700-3333-4333-8333-333333333333",
  "connectionId": "019b4700-4444-4444-8444-444444444444",
  "idempotencyKey": "technical-ping-42",
  "type": "BRIDGE_PING",
  "payload": { "nonce": "probe-42" },
  "issuedAt": "2026-09-19T14:00:00.000Z",
  "ackDeadlineAt": "2026-09-19T14:00:05.000Z",
  "executionDeadlineAt": "2026-09-19T14:00:30.000Z"
}
```

`CommandMap` liga type a payload e result. O contrato valida novamente em runtime,
rejeita tipos desconhecidos e copia somente os campos permitidos antes de awaits.
Payload/result de BRIDGE_PING aceitam exatamente `{ nonce: string }`; nonce tem
1–128 caracteres ASCII alfanuméricos ou `._:-`, sem execução/interpolação posterior.
Payload tem teto de 4096 bytes; result, 65536 bytes (migration incremental
CharacterResultLimit), tanto na aplicação quanto no check PostgreSQL. Character
contabiliza espaços estruturais de `jsonb::text`; ping permanece restrito ao nonce
curto. Entidades usam `object` para JSONB, evitando tipos
recursivos em QueryDeepPartialEntity; a fronteira interna continua tipada, sem any.

`commandId`, `correlationId`, `idempotencyKey`, type, payload, issuedAt e o prazo
total permanecem estáveis nos retries. `ackDeadlineAt` muda por tentativa;
`connectionId` pode mudar após reconexão. Essas diferenças não representam uma
nova execução lógica.

`correlationId` é UUID novo por command, com UNIQUE. `requestId` é copiado do
RequestContext existente, ou null fora dele, sem gerar contexto HTTP fictício.
`requestedByStaffId` é opcional, informado pelo domínio e protegido por FK.
Nenhum desses campos de contexto administrativo precisa ir no envelope.

## ACK e RESULT

ACK conceitual, passado a `acknowledge`:

```json
{
  "protocolVersion": "1",
  "serverId": "019b4700-3333-4333-8333-333333333333",
  "connectionId": "019b4700-4444-4444-8444-444444444444",
  "commandId": "019b4700-1111-4111-8111-111111111111",
  "correlationId": "019b4700-2222-4222-8222-222222222222"
}
```

RESULT repete esses cinco campos e acrescenta uma das alternativas:

```json
{ "outcome": "SUCCEEDED", "result": { "nonce": "probe-42" } }
```

```json
{ "outcome": "FAILED", "errorCode": "PING_REJECTED" }
```

Falhas remotas aceitam somente PING_REJECTED ou BRIDGE_ERROR. `errorMessage` não
faz parte do contrato remoto: se recebido como campo extra, não é copiado. O
backend grava mensagem local de catálogo, limitada a 256 caracteres; não armazena
stack remoto. TIMEOUT é gerado exclusivamente pelo backend.

Servidor, correlationId e sessão do último envio devem coincidir. A sessão deve
continuar ativa e saudável. Mensagens de sessão substituída/stale são rejeitadas,
inclusive duplicatas antigas. RESULT success precisa devolver o mesmo nonce.

ACK duplicado preserva o primeiro acknowledgedAt; ACK após terminal é no-op.
RESULT idêntico repete a resposta sem outro INSERT nem mudança de timestamp.
Resultado conflitante retorna conflito e preserva o original. RESULT recebido
em DISPATCHED infere ACK e termina atomicamente. Uma mensagem antes de qualquer
possível dispatch é rejeitada. RESULT após TIMEOUT já persistido gera conflito.
Se o deadline venceu mas o worker ainda não executou, o próprio receiver grava
TIMEOUT e o retorna, em vez de aceitar sucesso tardio.

## Lifecycle e transições

| Origem | Destino permitido | Condição |
| --- | --- | --- |
| PENDING | DISPATCHED | envio aceito/incerto, ACK/RESULT durante envio ou reserva abandonada |
| PENDING | FAILED | indisponibilidade esgotada, recusa permanente ou servidor disabled |
| DISPATCHED | ACKNOWLEDGED | ACK válido ou ACK inferido por RESULT |
| DISPATCHED | TIMEOUT | prazo total ou última janela de ACK esgotados |
| ACKNOWLEDGED | SUCCEEDED | RESULT success válido |
| ACKNOWLEDGED | FAILED | RESULT failure válido |
| ACKNOWLEDGED | TIMEOUT | prazo total esgotado |
| SUCCEEDED / FAILED / TIMEOUT | nenhuma | imutáveis nos serviços |

**FAILED = execução explicitamente falhou OU falha pré-entrega comprovada.**
**TIMEOUT = resultado final desconhecido após possível entrega.**
Uma recusa de retry ou desabilitação posterior não demonstra falha de execução e
nunca converte DISPATCHED em FAILED. RESULT de falha infere ACK quando necessário,
seguindo DISPATCHED → ACKNOWLEDGED → FAILED.

Reenvio mantém DISPATCHED; não há DISPATCHED → PENDING. Duplicatas são no-ops,
não transições. Toda conclusão e GameCommandResult são persistidos na mesma
transação. UNIQUE(game_command_id) permite no máximo um resultado. Checks validam
status/outcome, dispatchAttempts não negativo, tamanho JSON e completedAt
coerente com estado terminal. Não há updatedAt em command/result/connections.
Somente GameServer tem updatedAt, por representar cadastro mutável.

## Gateway, retry e concorrência

`GameGateway.send(connection, envelope, signal): Promise<TransportAcceptance>`
retorna `{ accepted: true }` ou `{ accepted: false, reason }`, sendo reason
UNAVAILABLE, TRANSIENT ou PERMANENT. Aceitação do transporte não é ACK nem sucesso
do Skyrim. UNAVAILABLE/PERMANENT garantem que essa tentativa não foi entregue;
TRANSIENT, exceção ou timeout representam entrega incerta.

O adapter padrão `DisconnectedGameGateway` sempre retorna UNAVAILABLE. Sem sessão
saudável nem se chama send. Recusa permanente antes de qualquer possível entrega
termina FAILED/DISPATCH_REJECTED. Indisponibilidade comprovada em todas as tentativas
termina FAILED/GATEWAY_UNAVAILABLE ao esgotar o limite. PENDING emite FAILED por
servidor disabled somente quando não existe uma tentativa em voo ou abandonada.

Depois de DISPATCHED, indisponibilidade, recusa permanente e desabilitação não
permitem inferir FAILED. O comando continua aceitando ACK/RESULT válidos até o
prazo. A última tentativa, inclusive recusada, mantém a janela de ACK; sem resposta,
termina TIMEOUT. ACKNOWLEDGED nunca é reenviado e expira pelo prazo total.

Cada tentativa elegível, inclusive verificação de disponibilidade sem sessão,
consome uma tentativa. Retry não cria command nem troca correlationId. Métodos de
varredura continuam explícitos, sem scheduler.

### Reserva persistente e I/O sem transação

**Nenhuma transação PostgreSQL ou row-level lock permanece aberta durante send.**
A reserva usa `dispatchLeaseId` UUID e `dispatchLeaseExpiresAt`, adicionados pela
migration incremental `1789831000000-GameDispatchLease`. Check exige ambos nulos
ou ambos preenchidos. Não foi alterada a migration GameBridge já aplicada.

1. Uma transação curta adquire locks GameServer → GameCommand, recupera reserva
   expirada e revalida status, servidor, conexão, limite de tentativas e deadlines.
2. Persiste tentativa, conexão, deadlines e lease de **2 segundos**. O prazo de send
   continua **1 segundo**. O status da primeira tentativa permanece PENDING durante
   a reserva: ainda não houve confirmação do transporte. PENDING com lease nunca
   pode ser tratado como pré-entrega comprovada por outro worker.
3. Faz commit e libera a conexão/locks. Só então chama GameGateway.send, com
   AbortSignal e verificação local de expiração antes do início do envio.
4. Uma nova transação curta reconcilia a resposta somente se dispatchLeaseId ainda
   corresponde à tentativa. Aceitação/incerteza promove PENDING → DISPATCHED.
   Recusa comprovada da primeira tentativa permite FAILED ou próximo retry PENDING.
   Recusa de retry DISPATCHED preserva a possibilidade de execução anterior.
5. ACK/RESULT pode chegar antes da reconciliação: uma mensagem válida comprova
   recebimento, promove PENDING → DISPATCHED se houver reserva, processa o lifecycle
   normal e limpa o lease. Uma resposta posterior do send perde a propriedade da
   tentativa e não sobrescreve ACK, resultado, timeout ou reserva de outro worker.

Outro processo encontra o lease persistido e não envia enquanto ele está válido,
mesmo se ackDeadlineAt já tiver vencido. Após expiração, uma reserva abandonada é
tratada conservadoramente como possível entrega: promove PENDING → DISPATCHED e
mantém o prazo total. Um novo envio exige também que o prazo de retry tenha vencido.
A comparação do token na reconciliação impede escrita tardia de proprietário antigo.
Os índices existentes de status/deadlines continuam atendendo as varreduras.

Conexões e mensagens continuam usando a ordem de locks estabelecida, mas não ficam
bloqueadas por network I/O. A conexão pode ser substituída durante send: o envelope
identifica a sessão reservada, mensagens da sessão encerrada são rejeitadas e um
retry elegível pode usar a nova sessão. O adapter deve vincular o envio à sessão
informada; não deve redirecioná-lo silenciosamente para outra conexão.

O adapter deve honrar abort e não iniciar envio depois do lease/deadline local.
Pausas de processo ou adapter que ignore cancelamento ainda podem gerar entrega
sobreposta/tardia após expiração da reserva. O lease protege a reserva e a escrita
no banco; não cancela fisicamente uma mensagem já enviada. O Agent deverá deduplicar
commandId/correlationId e respeitar executionDeadlineAt. Não há promessa de
exclusão absoluta de efeitos remotos nem de exactly-once.

### Crash windows

| Janela | Recuperação |
| --- | --- |
| A: commit da reserva, queda antes de send | Lease expira; entrega fica desconhecida, comando vira DISPATCHED conservadoramente. Retry preserva IDs; sem resposta termina TIMEOUT. |
| B: send, queda antes de reconciliação | ACK/RESULT ainda pode concluir pela reserva; recuperação/retry usa os mesmos IDs. |
| C: send incerto, exceção ou timeout | DISPATCHED; retry limitado e deadline absoluto, sem inferir FAILED. |
| D: outro worker disputa o mesmo command | Lock curto serializa claim; lease ativo impede segundo envio. Após expiração, token novo invalida reconciliação antiga. |

Não existe transação atômica entre PostgreSQL e transporte. A semântica é
**at-least-once**, com retries limitados: não garante execução nem exactly-once.
O futuro Agent deve persistir deduplicação por serverId/commandId, conferir
correlationId através de reconexões/reinícios e responder com o resultado anterior
sem repetir efeitos. O token de lease é exclusivamente interno, sem mudar o protocolo.

### Equivalência JSON e idempotência

Criação usa INSERT ON CONFLICT sobre UNIQUE(game_server_id, idempotency_key),
seguido de comparação de type/payload validado. `canonicalJson` ordena chaves de
objetos recursivamente, preserva posições de arrays e codifica escalares JSON sem
coerções arbitrárias. Por exemplo, `{"itemId":"x","quantity":1}` e
`{"quantity":1,"itemId":"x"}` possuem a mesma representação. Isso também vale
para objetos aninhados e objetos dentro de arrays; `[1,2]` difere de `[2,1]`.

Somente JSON válido é aceito: sem undefined, funções, getters, símbolos, ciclos,
arrays esparsos, objetos de classe ou números não finitos. Há limite de tamanho
de 4096 bytes para payload, 65536 para result e profundidade defensiva de 32 níveis.
A representação é construída
explicitamente; não depende de identidade nem de stringify de objetos não
canonicalizados. Não foi necessário payloadHash nem alteração de payload/result.
O contrato BRIDGE_PING permanece restrito a `{ nonce }`. Character valida cada
payload/result por tipo, normaliza identificadores opacos e verifica characterId
e targetId contra o payload persistido antes de concluir o comando.

Igual retorna o command original; diferente é conflito. Staff/requestId da
primeira criação são preservados nas repetições; outra chave/servidor é independente.
Resultados duplicados também usam a representação canônica para comparação.

ACK, RESULT e timeout usam os mesmos locks curtos; primeiro resultado válido vence.
No limite do deadline, TIMEOUT vence independentemente da ordem de aquisição.
O receiver verifica o prazo sem depender do worker. Falha no INSERT de resultado
reverte toda a conclusão, inclusive ACK inferido e alterações da reserva.

Não se registram AuditActions de transporte, payloads, resultados ou erros remotos
em logs. PostgreSQL é a fonte do lifecycle. Os serviços pressupõem uso interno;
não implementam autenticação do bridge pela rede. Escrita SQL administrativa direta
não é uma API de lifecycle: estados terminais são protegidos pela state machine dos
serviços, sem um novo trigger de imutabilidade do banco nesta etapa.

## Testes e rollback

`test/support/MockGameGateway` (arquivo `mock-game-gateway.ts`) permite conexão
indisponível, aceitação, recusa, exceção, envio bloqueado e histórico de envelopes.
Nunca é provider de produção. Relógio de testes avança sem sleeps reais.

A migration `1789830000000-GameBridge` adiciona quatro tabelas. A revisão adiciona
`1789831000000-GameDispatchLease`, cujo rollback remove somente os dois campos
de reserva e seu check; pare workers antes de reverter esse contrato de persistência. As FKs usam NO ACTION
para preservar histórico; remoções administrativas precisam de decisão explícita.
O rollback remove results → commands → connections → servers e seus índices,
perdendo somente os dados desta etapa. Migrations anteriores permanecem intactas.
As suítes PostgreSQL exercitam constraints, rollback/reaplicação, schema sem diff,
locks concorrentes e todos os fluxos. Sem a flag de integração, essas suítes são
ignoradas explicitamente conforme a convenção já existente.
