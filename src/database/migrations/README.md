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
