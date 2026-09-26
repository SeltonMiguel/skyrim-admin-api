# Deployment runbook (Etapa 12.2)

**Do not run more than one backend replica before Stage 12.5.**

A única topologia suportada é **uma instância do backend** contra um
PostgreSQL. Isso é imposto pelo código: no boot, a instância toma o advisory
lock `pg_advisory_lock(1397446994, 1)` (chave `0x534B5952 'SKYR'`, `1`),
numa conexão dedicada que fica fora do pool. Uma segunda instância, ou uma
migration, contra o mesmo banco falha na hora com `InstanceLockHeldError` e
exit 1. Se a conexão do lock cair (banco reiniciado, rede), a instância se
encerra (`LOCK_LOST`, exit 1) em vez de seguir sem lock; configure restart
automático (ex.: `restart: unless-stopped`).

**Estratégia de deploy: recreate.** A instância antiga para por completo antes
da migration e da nova instância. Rolling deploy, blue/green ou qualquer
sobreposição de duas instâncias não são suportados antes da 12.5; o lock
recusaria a segunda de qualquer forma.

## Artefatos

- Imagem: `Dockerfile` multi-stage.
  - Node 24.18.0 bookworm-slim, instalação com `npm ci`.
  - Runtime sem devDependencies, usuário `node` (uid 1000), `NODE_ENV=production`.
  - Código read-only (dono root).
  - Sem `.env` e sem segredos, que vêm do ambiente.
  - Healthcheck em `/api/v1/live`.
- Comandos dentro da imagem, sem rebuild:

| Uso | Comando |
| --- | --- |
| Aplicação | `node dist/main.js` (CMD) |
| Preflight | `node dist/database/preflight.js [--require-current]` |
| Migration | `node dist/database/migrate.js` |
| Bootstrap do coordenador | `node dist/staff/bootstrap.js` |

- Fora da imagem: `npm run start:prod`, `npm run preflight` e `npm run migration:run:prod` (sobre `dist/` já compilado). `npm run migration:run` segue para desenvolvimento (rebuild + CLI).

## Fronteira de schema

- **Runtime da aplicação: só lê e usa o schema.**
  - Nunca aplica migrations (`migrationsRun: false`), nunca sincroniza (`synchronize: false`) e **nunca cria extensões** (`installExtensions: false`: o TypeORM deixa de rodar `CREATE EXTENSION` ao conectar).
  - Com schema atrasado ou extensão ausente ela sobe, mas `/ready` responde 503.
- **Migration runner (`node dist/database/migrate.js`): o único que altera o schema.**
  - Antes de qualquer migration, garante as extensões exigidas com `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, de forma idempotente e com log.
  - É necessário porque a migration histórica VipStore usa `uuid_generate_v4()` e nunca cria a extensão; uma migration 26 rodaria tarde demais para ela.
  - Sem permissão, falha com `MigrationPrerequisiteError`, uma mensagem clara com o comando que um administrador deve executar.
- **Privilégios**:
  - a role da aplicação precisa de DML nas tabelas e **não** precisa de `CREATE EXTENSION` nem de DDL;
  - a role de migration precisa de DDL e, na primeira instalação, de `CREATE` no banco (`uuid-ossp` é trusted desde o PostgreSQL 13) ou de um administrador que crie a extensão antes;
  - produção pode usar roles separadas, informando a role de migration só no ambiente do `migrate.js`. Não há gestão de roles no backend.
- **Banco novo**: `migrate.js` cria `uuid-ossp`, aplica as 25 migrations, e o preflight com `--require-current` passa. Provado em `test/deployment-extensions.e2e-spec.ts` e no smoke de container.

## Probes

| Rota | Uso | Verifica |
| --- | --- | --- |
| `GET /api/v1/live` | liveness | só o processo e o event loop, sem I/O |
| `GET /api/v1/ready` | readiness (tráfego) | bootstrap concluído, sem shutdown em curso, lock mantido, banco responde, nenhuma migration desta build pendente. **Não depende do Agent** |
| `GET /api/v1/health` | legado | ping do banco (`{status, database}`); mantido por compatibilidade, os oficiais são `/live` e `/ready` |

`/ready` responde 200 `{"status":"ready"}` ou 503
`{"status":"not_ready","checks":{…booleanos}}`. É pequeno e sem configuração.

## Procedimento

Cada passo tem uma verificação. Pare no primeiro que falhar.

1. **Preflight da nova versão**, com a configuração de produção (só verifica, nunca cria nada):
   `node dist/database/preflight.js`.
   - Nenhum `ERROR`.
   - Cada `WARN` tem que ser uma decisão consciente: `TRUST_PROXY`, CORS e origins, HSTS, `DB_SSL_MODE`.
   - `migrations` lista o que será aplicado.
2. **Backup** (`docs/backup-restore.md`): `scripts/db-backup.sh`. Confirme o `.dump`, o `.meta.json` e o `pg_restore --list` que o script já executa. Sem backup verificado, não siga.
3. **Parar a instância antiga** com SIGTERM (`docker stop -t 15 <container>`).
   - Confirme `Graceful shutdown complete` no log e exit code 0.
   - O preflight deve mostrar `instance_lock: free`.
4. **Migration**: `node dist/database/migrate.js`.
   - Ela toma o mesmo lock, então recusa enquanto um backend estiver de pé e impede um backend de subir no meio.
   - Todas as pendentes rodam numa transação, com `DB_MIGRATION_STATEMENT_TIMEOUT_MS` e `DB_MIGRATION_LOCK_TIMEOUT_MS`.
   - Esperado: `Applied N migration(s)` ou `No pending migrations.`
5. **Preflight pós-migration**: `node dist/database/preflight.js --require-current` com exit 0.
6. **Subir a nova instância**.
7. **`/api/v1/live`** → 200.
8. **`/api/v1/ready`** → 200. Um 503 mostra em `checks` o que falta.
9. **Smoke**:
   - login Staff (`POST /api/v1/auth/login`);
   - `GET /api/v1/game-servers`;
   - um Agent de staging reconecta (HELLO → AUTHENTICATED; os Agents reconectam sozinhos após o 1001 `SHUTDOWN`);
   - `GET /api/v1/game-servers/:id` mostra `health: ONLINE`.
10. **Monitorar** os logs e a primeira hora de operação (métricas formais são da 12.3):
    - `Server control outcome UNCERTAIN`;
    - erros de worker (`tick failed`);
    - `Security` (throttling);
    - reconexões do Agent.

## Rollback e roll-forward

Produção é **forward-only**: não use `migration:revert` como rollback.

- **Aplicação nova com defeito e schema compatível** (a mudança seguiu expand/contract: colunas novas nullable ou com default, nada removido): pare a nova e suba a imagem anterior. Numa versão anterior ≥ 12.2, o preflight mostra `migrations_unknown` (schema à frente), o que é aceito, e `/ready` fica 200 porque só migrations conhecidas e pendentes bloqueiam.
- **Schema incompatível com a versão anterior**: **roll forward**, com uma correção na aplicação ou uma migration corretiva nova.
- **Perda ou corrupção de dados**: restore do backup do passo 2 (`docs/backup-restore.md`), aceitando a perda do que ocorreu depois dele.

Regras para migrations novas (as 25 históricas não mudam):
- expand/contract;
- `ADD CONSTRAINT … NOT VALID` seguido de `VALIDATE` separado;
- `CREATE INDEX CONCURRENTLY` em migration com `transaction = false`;
- backfill grande fora da migration, em lotes;
- nenhuma remoção junto com o código que ainda a usa.

## Falhas esperadas

| Sintoma | Causa | Ação |
| --- | --- | --- |
| Start falha com `InstanceLockHeldError` | outra instância ou migration está rodando | pare a outra; nunca rode duas |
| Migration falha com `InstanceLockHeldError` | backend de pé | passo 3 |
| Migration aborta por timeout | DDL lento ou lock ocupado | investigue os locks (`pg_stat_activity`) e ajuste `DB_MIGRATION_*`; a transação volta inteira |
| `/ready` 503 com `migrations:false` | schema atrás da build | passos 4 e 5 |
| `/ready` 503 com `database:false` | banco inacessível ou erro de query | verifique o banco; a instância fica fora de tráfego |
| Processo sai com `LOCK_LOST` | a conexão do lock caiu | normal após queda do banco; o restart automático a religa |
| Start falha com `Invalid environment variables: X` | configuração | corrija X (o valor nunca é impresso) |
| `docker stop` mata o processo antes de concluir | stop timeout menor que `SHUTDOWN_TIMEOUT_MS` | use um stop timeout maior; o estado do GameCommand e do Server Control está no banco, então as garantias se mantêm |

## Shutdown gracioso (SIGTERM/SIGINT)

`src/lifecycle/graceful-shutdown.ts`, com limite de `SHUTDOWN_TIMEOUT_MS`:

1. `/ready` passa a 503.
2. O roteador de upgrade para de aceitar WebSocket; os cinco loops (GameCommand, Server Control, entrega VIP, push de work do Agent, varredura de heartbeat) param de agendar e aguardam o tick em andamento.
3. O realtime Player/Staff fecha com 1001.
4. As sessões do Agent são persistidas como `SHUTDOWN` (nunca `STALE`) e fecham com 1001.
5. O lock é liberado e o pool do banco fecha.
6. O servidor HTTP fecha e o processo sai: 0 se limpo, 1 em timeout ou em `LOCK_LOST`.

Garantias:
- GameCommand PENDING continua no banco; uma tentativa já reservada segue o fluxo atual (lease → possivelmente entregue → retry com o mesmo commandId).
- Server Control que cruzou o claim nunca é reenviado e termina UNCERTAIN no deadline.

`test/deployment-lifecycle.e2e-spec.ts` prova os dois casos entre duas
instâncias sucessivas.

Proxy e TLS: `docs/reverse-proxy.md`. Variáveis: `docs/configuration.md`.
