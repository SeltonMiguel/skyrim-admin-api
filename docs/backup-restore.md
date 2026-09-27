# Backup and restore (Etapa 12.2)

O PostgreSQL é a **única** fonte de verdade do backend: contas, sessões,
ledger econômico, Audit, GameCommands, Server Control, work do Agent e VIP.
Volume Docker ou snapshot de disco sem consistência **não** é estratégia de
backup.

## Decisões do operador (abertas)

| Decisão | Valor | Efeito |
| --- | --- | --- |
| **RPO** (perda máxima aceitável) | **PRODUCT/OPS DECISION REQUIRED** | define a frequência. RPO de horas: `pg_dump` periódico basta. RPO de minutos: exige PITR (base backup + arquivamento de WAL) |
| **RTO** (tempo máximo de restauração) | **PRODUCT/OPS DECISION REQUIRED** | define a estratégia. O restore lógico cresce com o volume de dados; o RTO real é o **medido** no restore test, não o estimado |
| **Retenção** | **PRODUCT/OPS DECISION REQUIRED** | define o armazenamento: N diários + semanais + mensais; LGPD para dados de Player e Audit |
| Local e cifragem dos backups | **PRODUCT/OPS DECISION REQUIRED** | fora do servidor do banco, com acesso restrito e cifrado em repouso |

O ledger econômico e o Audit são append-only e não se reconstroem de outra
fonte: pesam para um RPO baixo.

Dados para decidir (nenhum valor é escolhido aqui): quanto de economia, trades,
compras e entregas VIP o produto aceita perder e reconciliar à mão com o Agent
(RPO); quanto tempo o jogo pode ficar sem backend (RTO, comparado com o restore
**medido** no volume real); exigências de LGPD para Audit e dados de Player e
o custo de armazenamento (retenção); onde o backup fica fora do servidor do
banco e quem tem a chave (local e cifragem).

### Restore test 12.7B (schema 27, local)

Banco de origem descartável migrado pelo runner de produção, com coordenador,
sessão Staff, game server e credencial de Agent reais; `db-backup.sh` e
`db-restore-verify.sh` executados num container `postgres:16`; restore num
banco novo; 29 tabelas críticas com contagens iguais à origem; tabelas efêmeras
da 27, colunas, índices, constraints, triggers e `uuid-ossp` presentes;
`preflight --require-current` com 27 aplicadas e 0 pendentes; app no banco
restaurado com `/api/v1/ready` 200 e login Staff. Tempo local ~4,8 s num dump
de 239 KB: **não é RTO** (volume e ambiente não representativos).

Enquanto essas decisões estiverem abertas, o item de backup do
`docs/release-readiness.md` continua aberto.

## Backup lógico

`scripts/db-backup.sh` faz o seguinte:
- roda `pg_dump --format=custom --compress=6 --no-owner --no-privileges` do banco inteiro: schema, dados, a extensão `uuid-ossp`, triggers append-only e as 25 migrations;
- verifica o arquivo com `pg_restore --list`;
- escreve um `.meta.json` com data (UTC), versão do servidor e do `pg_dump`, número de entradas, migrations aplicadas, a última migration, tamanho e sha256.

```bash
export PGHOST=db.internal PGPORT=5432 PGUSER=skyrim PGDATABASE=skyrim
# senha por ~/.pgpass (chmod 600) ou PGPASSFILE; evite PGPASSWORD em shells compartilhados
BACKUP_DIR=/secure/backups scripts/db-backup.sh
```

- Credenciais só pelo ambiente do libpq; nada secreto na linha de comando nem no metadata.
- Arquivos com `umask 077`.
- O `pg_dump` precisa ter a mesma versão major do servidor, ou maior. Sem cliente instalado, use a imagem `postgres:<major>` montando `scripts/` e o diretório de destino.
- É um backup consistente: o `pg_dump` usa um snapshot, e pode rodar com a aplicação de pé.
- Antes de cada `migrate` em produção, rode um backup e verifique-o (`docs/deployment.md`, passo 2).

Nunca faça commit de arquivos de backup (`*.dump` e `backups/` estão fora da
imagem pelo `.dockerignore`; mantenha-os fora do repositório).

## Restore verificado

Restore é o caminho para perda ou corrupção de dados. Não é rollback de schema: produção é forward-only, migrations publicadas não são editadas e `migration:revert` não é procedimento de produção (`docs/deployment.md`).

`scripts/db-restore-verify.sh <arquivo.dump> <banco_novo>`:

1. confere o sha256 contra o `.meta.json`;
2. `pg_restore --list` (arquivo legível);
3. `createdb` de um banco **novo**; se o banco já existe, recusa com exit 2, então nunca sobrescreve;
4. `pg_restore --exit-on-error --no-owner --no-privileges`;
5. confere as 29 tabelas críticas (inclui a evidência de operador da migration 26: `operator_actions`, `vip_reward_delivery_attempts`, `agent_work_rejections`) e, da migration 27, só schema: tabelas efêmeras de coordenação (sem comparar contagem), `game_connections.owner_instance_id`, índices e constraints;
6. com `SOURCE_DATABASE`, compara a contagem de linhas com a origem;
7. confere os triggers append-only (Audit, ledger) e a extensão `uuid-ossp`;
8. informa as migrations restauradas;
9. `DROP_AFTER=1` apaga o banco de teste no fim.

Depois, rode o preflight e suba a aplicação contra o banco restaurado:

```bash
DB_DATABASE=<banco_novo> node dist/database/preflight.js --require-current
DB_DATABASE=<banco_novo> node dist/main.js   # /api/v1/ready → 200, login Staff
```

Promover um restore a produção é um procedimento do operador:
1. parar a aplicação;
2. apontar `DB_DATABASE` para o banco restaurado, ou renomear;
3. subir.

Depois de um restore:
- tudo o que aconteceu após o ponto do backup se perde;
- o Host Agent pode ter efeitos físicos que o backend "esqueceu" (entregas, custódia): reconcilie pelo journal do Agent e pelas operações abertas;
- sessões Staff e Player posteriores ao backup deixam de existir; os usuários fazem login de novo.

## Restore test executado na 12.2

Ambiente descartável: container `postgres:16` próprio e rede Docker dedicada,
sem tocar no banco de desenvolvimento. Resultado:

| Passo | Resultado |
| --- | --- |
| Banco fonte | 25 migrations aplicadas pela imagem (`node dist/database/migrate.js`), coordenador criado pelo bootstrap e 1 game server |
| Backup | `pg_dump` 16.14, formato custom: 212 615 bytes, 398 entradas, sha256 registrado |
| `pg_restore --list` | OK |
| Restore em banco novo | OK; reexecutar sobre um banco existente é recusado (exit 2) |
| Tabelas críticas e contagens vs. origem | 26/26 iguais (migrations 25, permissions 37, role_permissions 95, staff 1, audit 1, game_servers 1…) |
| Triggers append-only e `uuid-ossp` | presentes |
| Preflight `--require-current` no restaurado | sem ERROR, 25 applied / 0 pending |
| Aplicação no restaurado | `/api/v1/ready` 200 e login do coordenador 200 |
| Limpeza | banco restaurado, containers, rede e arquivos removidos |

Repita esse teste a cada release e periodicamente, e registre o RTO medido.
