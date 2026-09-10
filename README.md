# Skyrim Admin API

Backend administrativo do Skyrim Brasil / SkyMP. A Etapa 00 contém somente
infraestrutura; autenticação, permissões e domínios do jogo ficam para etapas futuras.

## Desenvolvimento local

Requisitos: Node.js 22 ou superior (validado com Node 24), npm e Docker com Compose v2.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migration:run
npm run start:dev
```

O Compose inicia PostgreSQL 16 na porta 5432, com as configurações de `.env.example`:
banco `skyrim_admin`, usuário `skyrim` e senha `skyrim`. As credenciais são lidas de
`.env`; não versione esse arquivo. A porta fica vinculada ao loopback local.
A API roda localmente, fora do Docker. Aguarde o banco ficar saudável em
`docker compose ps` antes de iniciar a API.

- Swagger: http://localhost:3000/docs
- OpenAPI JSON: http://localhost:3000/docs-json
- Health: http://localhost:3000/api/v1/health

```bash
curl -i -H 'x-request-id: local-check' http://localhost:3000/api/v1/health
```

O health executa `SELECT 1` no PostgreSQL: retorna HTTP 200 com
`{"status":"ok","database":"up"}` ou HTTP 503 padronizado quando a consulta falha.
O bootstrap exige banco acessível; a aplicação não sobe com conexão inválida.
O pool limita conexão e consulta a 5 segundos, com até 3 tentativas no bootstrap.

`docker compose down` preserva os dados no volume. Alterar usuário, senha ou nome
do banco em `.env` não reconfigura um volume PostgreSQL já inicializado.
No WSL, habilite a integração da distribuição no Docker Desktop se o comando
`docker` não estiver disponível.

## Configuração e infraestrutura

`ConfigModule` é global e valida as variáveis com Joi antes de conectar. API e CLI
compartilham a validação e as opções de conexão. Variáveis exportadas no processo
prevalecem sobre `.env`. Host, usuário, senha e banco são obrigatórios; portas devem
ser inteiros de 1 a 65535. `NODE_ENV` aceita development, test ou production.
`DB_LOGGING=true/false` sobrescreve o padrão: ligado em development, desligado nos
outros ambientes. Não há acesso a `process.env` fora da camada de configuração
no código da aplicação.

O TypeORM usa `synchronize: false` e `migrationsRun: false`. O carregamento de
entidades e migrations usa apenas JavaScript compilado em `dist`, tanto na API
quanto no CLI. A aplicação mantém ESM e os imports locais com extensão `.js`.

A API usa prefixo `/api` e versionamento URI oficial do Nest (`v1`). `setupApp`
aplica a mesma configuração HTTP no bootstrap e nos testes. O `AppExpressAdapter`
registra o fallback 404 na raiz: no Nest 12 ele seria limitado ao prefixo, enquanto
este servidor hospeda uma única aplicação e precisa padronizar todas as URLs.

O `ValidationPipe` global usa somente `whitelist: true`,
`forbidNonWhitelisted: true` e `transform: true`. DTOs futuros devem declarar
validadores e conversões explícitas; conversão implícita ampla não está habilitada.

Cada resposta recebe `x-request-id`. Um valor recebido é preservado se tiver de
1 a 128 caracteres ASCII alfanuméricos ou `._:-`; valores ausentes, duplicados ou
inválidos são substituídos por UUID. Essa restrição evita headers e identificadores
de log inválidos ou excessivos. Injete `RequestContext` para ler `requestId`;
`AsyncLocalStorage` mantém o isolamento entre requisições concorrentes. Fora de uma
requisição o valor é `undefined`. O middleware precede até o parser JSON e o Swagger.

Erros preservam status/mensagens de `HttpException`, inclusive arrays de validação.
Falhas inesperadas são registradas internamente com request ID e retornam mensagem
genérica, sem stack trace, em todos os ambientes:

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "Database unavailable",
  "path": "/api/v1/health",
  "requestId": "local-check",
  "timestamp": "2026-09-09T00:00:00.000Z"
}
```

## Migrations

```bash
npm run migration:create -- src/database/migrations/NomeDaMigration
npm run migration:generate -- src/database/migrations/NomeDaMigration
npm run migration:run
npm run migration:revert
```

`create` cria um arquivo TypeScript para edição manual e não precisa do banco.
`generate`, `run` e `revert` compilam antes de usar `dist/database/data-source.js`.
`generate` compara entidades com o banco; sem diferenças encerra com código 1,
comportamento esperado na Etapa 00. `revert` desfaz a última migration executada.
Não há migration artificial nem entidades de domínio nesta etapa.
`run` pode criar somente a tabela de controle `migrations` do TypeORM.

## Verificação

```bash
npm run lint
npm run build
npm test
npm run test:e2e
```

Oxlint foi mantido do projeto inicial. Os testes usam Jest com ts-jest e suporte
ESM (`--experimental-vm-modules`, que pode emitir um aviso do Node).
Os unitários cobrem configuração, opções críticas do banco e isolamento de contexto.
Os e2e HTTP inicializam os módulos reais, substituindo somente a fronteira
`DataSource`; cobrem health, erros, validação, concorrência, request ID e Swagger.
Não precisam de PostgreSQL, mas precisam poder abrir uma porta HTTP local.

Para incluir a suíte com PostgreSQL real, após o setup:

```bash
TEST_DATABASE_INTEGRATION=true npm run test:e2e
```

Essa suíte valida conexão, opções e health contra o banco configurado, sem alterar
o schema. Sem a flag, ela é explicitamente ignorada. `npm run test:cov` gera cobertura.

Para executar o build: `npm run build && npm run start:prod`.

## Estrutura

```text
src/
  common/
    filters/          # Contrato e filtro global de erros
    http/             # Adaptador HTTP e fallback 404
    middleware/       # Request ID
    request-context/  # Contexto assíncrono por requisição
  config/             # ConfigModule e validação compartilhada
  database/           # Conexão Nest e DataSource do CLI
    migrations/
  health/             # Consulta real de disponibilidade
  app.module.ts
  main.ts
  setup-app.ts
test/                 # Suítes HTTP e PostgreSQL real
```

O repositório inicial já rastreava `node_modules`. O `.gitignore` impede novos
artefatos, mas não remove arquivos já rastreados; instalações podem aparecer no
`git status`. A Etapa 00 não altera o índice nem o histórico Git.
