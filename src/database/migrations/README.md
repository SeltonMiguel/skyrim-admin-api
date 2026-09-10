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

A Etapa 00 não cria tabelas de domínio nem uma migration vazia artificial.
`migration:run` inicializa a tabela de controle do TypeORM mesmo sem migrations.
