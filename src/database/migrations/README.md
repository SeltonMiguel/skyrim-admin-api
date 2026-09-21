# Migrations

Crie migrations TypeScript neste diretório:

```bash
npm run migration:create -- src/database/migrations/NomeDaMigration
npm run migration:generate -- src/database/migrations/NomeDaMigration
```

O CLI usa `dist/database/data-source.js`. Os scripts generate/run/revert compilam
antes de executar; o glob carrega somente migrations `.js` de `dist`, evitando
duplicação entre fonte e build. Generate precisa do PostgreSQL e de diferenças
entre entidades e schema. Sem diferenças, o TypeORM encerra com código 1.

A Etapa 01 adiciona `1789810000000-AuthRbac.ts`: cinco tabelas, seis roles,
29 permissions e 71 grants explícitos. O seed é um snapshot independente do código
atual; mudanças futuras exigem nova migration. Execuções repetidas de `run` são
idempotentes pelo histórico do TypeORM. `down` remove tabelas e dados em ordem
inversa de dependência; não use em um banco com dados que devem ser preservados.

A Etapa 02 adiciona `1789820000000-AuditLog.ts` sem modificar a migration anterior.
Cria `audit_logs`, seis índices de consulta, a função `reject_audit_log_mutation`
e o trigger `audit_logs_immutable`, habilitado como ALWAYS, que rejeita UPDATE,
DELETE e TRUNCATE. `down` remove trigger, função e tabela nessa ordem; os dados de
auditoria são perdidos no rollback. `actor_staff_id` é um identificador histórico
sem FK, preservando os snapshots mesmo se um staff for removido excepcionalmente.

A migration `1789830000000-GameBridge` cria `game_servers`, `game_connections`,
`game_commands` e `game_command_results`. Inclui FKs, code único, uma conexão ativa
por servidor (índice parcial), idempotência por servidor/chave, correlationId único
e um resultado por command. Checks limitam JSON a 4096 bytes, validam status/outcome,
contagem de tentativas e datas de conclusão/desconexão. Índices cobrem heartbeat,
status/deadlines de dispatch/execução, servidor, conexão e requestId.
O rollback remove resultados, comandos, conexões e servidores nessa ordem, com
perda dos dados desta etapa. Não altera Auth/RBAC ou Audit. Lifecycle completo e
limites de concorrência estão em `docs/game-bridge-protocol.md` na raiz do projeto.

A revisão pontual da Etapa 03 adiciona `1789831000000-GameDispatchLease`, sem editar
a migration GameBridge aplicada. São dois campos nullable em `game_commands`:
`dispatch_lease_id` UUID e `dispatch_lease_expires_at` timestamptz, com check para
presença conjunta. A reserva persiste antes do send e permite liberar transações
antes de I/O externo. O rollback remove somente os campos e o check; interrompa
workers antes de reverter. Não há payloadHash nem nova configuração.
