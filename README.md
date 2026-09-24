# Skyrim Admin API

Backend administrativo do Skyrim Brasil / SkyMP. Foundation (Etapa 00),
autenticação/RBAC (Etapa 01), auditoria administrativa (Etapa 02) e infraestrutura
de Game Bridge/Commands (Etapa 03), consultas administrativas (Etapa 04) e
Character Management assíncrono (Etapa 05), Moderation (Etapa 06), World Management
(Etapa 07) e catálogo VIP Store (Etapa 08).
O transporte real para Skyrim continua
reservado a uma etapa futura.

## Desenvolvimento local

Requisitos: Node.js 22 ou superior (validado com Node 24), npm e Docker com Compose v2.

```bash
cp .env.example .env
# Configure JWT_ACCESS_SECRET e JWT_REFRESH_SECRET antes de continuar (veja abaixo).
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
Falhas inesperadas registram apenas classe do erro e request ID e retornam mensagem
genérica, sem stack trace, em todos os ambientes. O logger do banco omite SQL,
parâmetros e mensagens do driver para não registrar credenciais ou hashes:

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
comportamento esperado quando o schema está atualizado. `revert` desfaz a última migration executada.
A migration `1789810000000-AuthRbac` cria `roles`, `permissions`, `role_permissions`,
`staff_users` e `staff_sessions`, e cadastra seis roles, 29 permissions e 71 grants.
O seed está congelado na migration, com `ON CONFLICT DO NOTHING`; repetir `run`
não duplica dados. Alterações futuras da matriz exigem nova migration.
O rollback remove essas cinco tabelas e seus dados, em ordem de dependência.
Use rollback somente quando a perda desses dados for intencional.

## Autenticação e bootstrap inicial

Configure duas chaves aleatórias **diferentes**, cada uma com pelo menos 32 caracteres
e sem espaços, em `JWT_ACCESS_SECRET` e `JWT_REFRESH_SECRET`. Gere cada chave com
`node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`
e guarde no `.env` local ou secret manager. Não versione as chaves.
Elas são obrigatórias em development/production; somente testes podem usar chaves
aleatórias efêmeras por processo. Nunca há segredo ou senha padrão.

`JWT_ACCESS_TTL=15m` e `JWT_REFRESH_TTL=7d` aceitam inteiros positivos com `s`, `m`,
`h` ou `d`. Access tem limite de uma hora; refresh deve durar mais que access e no
máximo 90 dias. A configuração é validada também no CLI de migrations.

Após `npm run migration:run`, execute explicitamente o bootstrap. Exemplo em Bash,
sem colocar a senha no histórico (também é possível usar variáveis temporárias no `.env`):

```bash
read -r -p 'Username: ' BOOTSTRAP_COORDINATOR_USERNAME
read -r -p 'Nome: ' BOOTSTRAP_COORDINATOR_DISPLAY_NAME
read -r -s -p 'Senha (12–128 caracteres): ' BOOTSTRAP_COORDINATOR_PASSWORD
export BOOTSTRAP_COORDINATOR_USERNAME BOOTSTRAP_COORDINATOR_DISPLAY_NAME BOOTSTRAP_COORDINATOR_PASSWORD
npm run staff:bootstrap
unset BOOTSTRAP_COORDINATOR_USERNAME BOOTSTRAP_COORDINATOR_DISPLAY_NAME BOOTSTRAP_COORDINATOR_PASSWORD
```

O comando normaliza o username, valida as credenciais, usa Argon2id e cria somente
o primeiro Coordinator. Execuções concorrentes são serializadas. Se já existir
qualquer Coordinator (inclusive desativado), informa que nada foi alterado;
não troca senha, não reativa e não cria duplicatas. Sem credenciais válidas, falha
sem criar staff. Não há bootstrap automático nem endpoint público correspondente.
Remova também as variáveis temporárias do `.env`, se usadas.

| Método | Endpoint | Entrada / acesso |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | `username`, `password`; retorna tokens e staff público |
| POST | `/api/v1/auth/refresh` | `refreshToken`; retorna novo par de tokens |
| POST | `/api/v1/auth/logout` | Bearer access; revoga sessão atual; HTTP 204 |
| GET | `/api/v1/auth/me` | Bearer access; staff e permissões atuais |
| GET | `/api/v1/staff` e `/api/v1/staff/:id` | `STAFF_READ` |
| POST | `/api/v1/staff` | `STAFF_WRITE`; `username`, `displayName`, `password`, `role` |
| PATCH | `/api/v1/staff/:id` | `STAFF_WRITE`; `username` e/ou `displayName` |
| PATCH | `/api/v1/staff/:id/role` | `STAFF_WRITE`; `role` |
| PATCH | `/api/v1/staff/:id/status` | `STAFF_WRITE`; `status`: `ACTIVE` ou `DISABLED` |

No Swagger, execute login e cole apenas o `accessToken` em **Authorize → bearer**.
As respostas nunca incluem hashes. Username aceita 3–64 caracteres ASCII
alfanuméricos, ponto, hífen e underscore; é convertido para minúsculas e sem espaços
nas extremidades. Senhas têm 12–128 caracteres e não podem conter apenas espaços.

JWTs usam HS256, chaves e audiences separados, `sub`, `sid` e `jti` aleatório.
Cada request protegida consulta sessão, status e permissões atuais no banco.
Logout e desativação invalidam imediatamente access e refresh em requests futuras;
requests já autorizadas em andamento podem concluir. Desativação revoga todas as
sessões; reativação exige novo login. A última conta Coordinator ativa não pode ser
desativada ou rebaixada, inclusive em alterações concorrentes.

Refresh é armazenado somente como SHA-256 (o token tem assinatura e identificador
aleatórios); senhas usam Argon2id, 64 MiB, três iterações e paralelismo 1. Refresh
rotaciona atomicamente: apenas uma tentativa concorrente pode consumir o token.
Reuso recebe 401 sem revogar o sucessor válido. A expiração absoluta da sessão é
definida no login usando `JWT_REFRESH_TTL` e nunca é renovada pelo refresh.
A rotação atualiza somente o hash e `lastUsedAt`; o `exp` do refresh JWT nunca
ultrapassa `StaffSession.expiresAt` (arredondado para baixo em segundos).
Access tokens anteriores continuam válidos até seu TTL enquanto a sessão estiver
ativa. Ao atingir `expiresAt`, access e refresh são rejeitados com 401; um novo
login cria outra sessão com nova expiração. Credenciais inválidas recebem a mesma
mensagem de 401; autenticação válida sem as permissions necessárias recebe 403.

A matriz explícita está em `src/rbac/role-permissions.ts` e seu snapshot versionado
nas migrations. COORDINATOR possui todas as permissions; DEV recebe `SERVER_START`,
`SERVER_PAUSE`, `SERVER_RESTART` e as leituras operacionais `DASHBOARD_READ` e
`GAME_BRIDGE_READ`. Apenas COORDINATOR recebe `STAFF_READ`,
`STAFF_WRITE` e `VIP_STORE_WRITE`. Controllers usam `@RequirePermissions` e guards,
sem comparar níveis de cargo. Nenhuma funcionalidade do jogo é executada nesta etapa.

## Auditoria administrativa

`AuditLog` é o histórico persistente e append-only de ações administrativas.
Registra `STAFF_CREATE`, `STAFF_UPDATE`, `STAFF_ROLE_CHANGE`, `STAFF_STATUS_CHANGE`,
`AUTH_LOGIN`, `AUTH_LOGOUT` e `COORDINATOR_BOOTSTRAP`. Login é registrado somente
quando bem-sucedido; refresh e leituras não geram eventos. O bootstrap registra
somente a criação inicial, com ator e contexto HTTP nulos.

A migration `1789820000000-AuditLog` cria `audit_logs`, seus índices e um trigger
`ENABLE ALWAYS` que rejeita UPDATE, DELETE e TRUNCATE, inclusive via SQL direto.
Não existe `updatedAt` nem API de mutação. O rollback remove trigger, função e
tabela (com seus dados). A proteção não impede um administrador do banco de
alterar o schema ou desabilitar o trigger.

| Método | Endpoint | Acesso |
| --- | --- | --- |
| GET | `/api/v1/audit` | `AUDIT_READ` |
| GET | `/api/v1/audit/:id` | `AUDIT_READ` |

A matriz permanece igual: Coordinator, General Chief, Admin e Moderator podem
consultar; Support e Dev recebem 403; requests anônimas recebem 401.
A listagem aceita `page` (padrão 1), `limit` (padrão 20, máximo 100) e filtros
exatos `actorStaffId`, `action`, `outcome`, `resourceType`, `resourceId` e
`requestId`. `from`/`to` são limites inclusivos em ISO 8601 com timezone; intervalos
invertidos são rejeitados. A resposta contém `items`, `total`, `page`, `limit` e
`totalPages`, ordenados por `createdAt DESC, id DESC`. Swagger documenta os DTOs.

O ator vem da autenticação e seu username, displayName e role são copiados no
momento da ação. `actorStaffId` identifica o staff sem FK: o histórico permanece
válido mesmo diante de uma remoção excepcional do staff. Não há JOIN para
reconstruir a identidade passada. O contexto usa o mesmo `x-request-id` da resposta,
via AsyncLocalStorage, e somente método, caminho sem query string, IP e user-agent.
Não são copiados body, headers completos, cookies ou mensagens de erro.

A abstração `AuditService.execute` executa a mutação e o SUCCESS na mesma
transação. Se a gravação falhar, a mutação é revertida e retorna 503. Erros de
operações autenticadas que já entraram no service geram FAILURE em uma gravação
separada, depois do rollback; o status original é preservado quando essa gravação
funciona. Se nem FAILURE puder ser persistido, retorna 503 e emite apenas um aviso
técnico seguro com request ID. Não há retry automático que possa duplicar eventos.
Uma indisponibilidade total do banco impede persistir a evidência de falha;
a aplicação nunca confirma uma mutação sem seu SUCCESS. Rejeições nos guards ou
na validação anterior ao service não são auditadas nesta etapa.

Metadata é construída explicitamente: campos alterados no perfil, roles ou status
anteriores/novos. Um sanitizer recursivo remove chaves sensíveis, inclusive em
arrays e com variações de caixa/separadores, e limita profundidade, tamanho e
quantidade de elementos. Senhas, hashes, tokens, secrets, credenciais e objetos de
erro não são contexto de auditoria. Essa defesa por chaves não substitui a seleção
explícita de campos seguros em cada nova ação.

## Game Bridge e comandos internos

A Etapa 03 adiciona GameServer, GameConnection, GameCommand e GameCommandResult,
com migration explícita e serviços internos exportados por GameBridgeModule.
BRIDGE_PING permanece disponível; a Etapa 05 acrescenta 17 comandos tipados de
Character Management, a Etapa 06 acrescenta oito de Moderation e a Etapa 07 quatro
de World Management, totalizando 30 tipos fechados. GameGateway usa DisconnectedGameGateway em produção:
nunca simula execução bem-sucedida. O MockGameGateway existe somente nos testes.

Commands usam idempotência por servidor/chave, correlationId próprio, requestId
do contexto quando existente e state machine centralizada. Dispatch, ACK, RESULT,
retry e timeout usam transações curtas e locks PostgreSQL. O envio externo ocorre
fora da transação, protegido por reserva persistente de tentativa. Mensagens duplicadas
não repetem conclusão; RESULT antes de ACK infere recebimento atomicamente.
Conexões mantêm histórico, supersession e heartbeat sem ressuscitar sessões antigas.
Não há scheduler: operações de dispatch/expiração são chamadas explicitamente.

Configure os quatro valores GAME_* documentados em `.env.example`. A política usa
prazo total fixo desde a reserva da primeira possível entrega e retry limitado; transporte
indisponível nunca gera sucesso. FAILED representa falha explícita do bridge ou
pré-entrega comprovada; após possível entrega, ausência de resposta resulta em TIMEOUT. O futuro Agent precisará deduplicar efeitos, pois
send e commit PostgreSQL não formam uma única transação. Nenhum lifecycle técnico
entra no AuditLog. Consulte [o protocolo e as decisões](docs/game-bridge-protocol.md)
para envelopes, transições, limites, timeouts e contrato de cancelamento do adapter.

## Dashboard e consultas administrativas

A Etapa 04 expõe somente GET autenticados. `DASHBOARD_READ` e `GAME_BRIDGE_READ`
são concedidas explicitamente às seis roles (COORDINATOR, GENERAL_CHIEF, ADMIN,
MODERATOR, SUPPORT e DEV), sem ampliar permissões de escrita ou `AUDIT_READ`.
A migration incremental `1789840000000-AdminQueries` acrescenta duas permissions
e 12 vínculos, totalizando 31 permissions e 83 grants; migrations anteriores não mudam.

| Endpoint (prefixo `/api/v1`) | Permission | Filtros |
| --- | --- | --- |
| `GET /dashboard` | DASHBOARD_READ | Nenhum; janela fixa de 24h |
| `GET /game-servers` | GAME_BRIDGE_READ | code exato, enabled (`true`/`false`), health, page, limit |
| `GET /game-servers/:id` | GAME_BRIDGE_READ | UUID do servidor |
| `GET /game-servers/:id/connections` | GAME_BRIDGE_READ | status, from, to, page, limit |
| `GET /game-servers/:id/commands` | GAME_BRIDGE_READ | status, type, requestedByStaffId, requestId, correlationId, from, to, page, limit |
| `GET /game-commands/:id` | GAME_BRIDGE_READ | UUID do comando |

Dashboard retorna `generatedAt`, contadores de servidores e comandos criados no
intervalo inclusivo `[generatedAt - 24h, generatedAt]`, com `windowHours: 24`,
total, `byStatus` e `attentionRequired = FAILED + TIMEOUT`. Usa agregações no
PostgreSQL, sem incluir AuditLog, dados pessoais, payloads ou resultados. Pequenas
diferenças entre contagens concorrentes são aceitáveis; não há locks de leitura.

Health é derivado pelo `BridgeClock` e pelo timeout de heartbeat existente:
`DISABLED` tem precedência quando enabled=false; `ONLINE` exige conexão CONNECTED
com heartbeat ainda válido; `STALE` significa CONNECTED com heartbeat vencido
(inclusive no instante exato do timeout); `OFFLINE` significa ausência de CONNECTED.
Detectar STALE não atualiza a conexão. `currentConnection` é a conexão CONNECTED,
ou null, inclusive quando há apenas histórico de conexões encerradas.

Listagens retornam `{ items, total, page, limit, totalPages }`, com page=1,
limit=20, máximo 100 por página e page até 1000000, como Audit. Total zero implica
totalPages=0. Servidores ordenam por name ASC/id ASC; conexões por connectedAt
DESC/id DESC; comandos por createdAt DESC/id DESC. Datas from/to são ISO 8601 com
timezone, inclusivas, filtram connectedAt nas conexões e createdAt nos comandos;
intervalos invertidos são rejeitados. Não há ordenação SQL configurável pelo cliente.
UUID inválido retorna 400; recurso/servidor inexistente retorna 404; histórico vazio
de servidor existente retorna 200. Filtros desconhecidos são rejeitados.

Presenters usam allowlists. Listagem e detalhe genéricos não carregam payload nem
result body, inclusive para BRIDGE_PING. O detalhe expõe deadlines, timestamps e
somente outcome/errorCode/receivedAt do resultado. idempotencyKey, characterId,
IDs de alvos, tokens de lease/ownership e segredos de autenticação ficam ocultos.
Consultas não alteram estado nem geram AuditLog; requestId segue a infraestrutura
HTTP existente. GameCommandBus permanece interno; os POSTs das Etapas 05/06 escolhem
tipos fixos e exigem suas próprias permissions.
Swagger documenta filtros, respostas e erros. Joins evitam consultas por servidor
ou por comando; paginação/counts usam um número constante de queries.

## Character Management

A Etapa 05 aceita 17 operações em
`POST /api/v1/game-servers/:serverId/characters/:characterId/...` com JWT,
permission específica e `Idempotency-Key` obrigatório. Todos retornam 202 e
`Location: /api/v1/character-operations/:commandId`. 202 significa aceitação
persistida; a execução depende do lifecycle do bridge. Servidor disabled retorna
409; enabled offline/stale aceita PENDING.

Mutations gravam GameCommand + AuditLog SUCCESS atomicamente; falha de auditoria
retorna 503 e desfaz a criação. Queries não geram AuditLog. Retry HTTP equivalente
retorna os mesmos IDs sem novo Audit ou dispatch. O dispatcher existente faz
reserva/commit antes de send, sem transação aberta durante I/O; não há scheduler
ou Agent real nesta etapa.

`GET /api/v1/character-operations/:commandId` expõe payload/result tipados somente
com a permission correspondente ao tipo. GAME_BRIDGE_READ não dá acesso ao domínio.
Não são criados snapshots: Skyrim continua sendo a fonte de verdade.

Payload tem teto de 4096 bytes; result, 65536 bytes, incluindo representação
`jsonb::text`. A migration incremental `1789850000000-CharacterResultLimit` altera
somente o check de result. Consulte [contratos, endpoints, auditoria e decisões](docs/character-management.md).

## Moderation

A Etapa 06 aceita oito operações tipadas em
`POST /api/v1/game-servers/:serverId/moderation/...`: ban/unban, god mode SET,
noclip SET, invisibility SET, announcement e teleport nas duas direções.
`actorStaffId` vem exclusivamente da autenticação nas ações de staff; o cliente
não pode escolher outro staff. SET exige boolean explícito, incluindo false.

Todas exigem Idempotency-Key e permission existente; retornam 202 com
`Location: /api/v1/moderation-operations/{commandId}`. O detalhe exige a permission
do CommandType persistido. Support só possui PLAYER_TELEPORT_TO_STAFF; DEV não
possui Moderation. O endpoint genérico continua exibindo apenas metadata operacional.

Character e Moderation compartilham `AdministrativeCommandService`, extraído do
fluxo da Etapa 05: Command + Audit SUCCESS na mesma transação, rollback em falha
de Audit, replay sem criação/auditoria/envio adicional e commit antes do dispatcher.
SUCCESS significa solicitação aceita pelo backend. Reason e message ficam no
payload autorizado da operação, nunca no Audit. Não há tabelas locais de estados
de moderação nem migration nova. Limites continuam 4 KiB/64 KiB.

Consulte [contratos, endpoints, matriz e decisões](docs/moderation.md).

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

A suíte Foundation continua validando conexão, opções e health sem alterar tabelas.
As suítes Auth/RBAC, Audit, Game Bridge e Admin Queries criam schemas temporários exclusivos no PostgreSQL,
executam migration/rollback/reaplicação, bootstrap e fluxos HTTP e removem os
schemas ao terminar.
O usuário de teste precisa de permissão para criar schemas. Dados de staff do schema
normal não são alterados. Sem a flag, as suítes de banco são explicitamente
ignoradas. `test:e2e` compila primeiro para carregar entidades/migrations de `dist`.
`npm run test:cov` gera cobertura.

Para executar o build: `npm run build && npm run start:prod`.

## Estrutura

```text
src/
  audit/              # Histórico append-only e consultas protegidas
  auth/               # Login, JWT, sessões e guards
  rbac/               # Roles, permissions e grants explícitos
  staff/              # Gestão de staff e CLI de bootstrap
  common/
    filters/          # Contrato e filtro global de erros
    http/             # Adaptador HTTP e fallback 404
    middleware/       # Request ID
    request-context/  # Contexto assíncrono por requisição
  config/             # ConfigModule e validação compartilhada
  database/           # Conexão Nest e DataSource do CLI
    migrations/
  game-bridge/        # Servidores, conexões, comandos e gateway interno
  health/             # Consulta real de disponibilidade
  app.module.ts
  main.ts
  setup-app.ts
test/                 # Suítes HTTP e PostgreSQL real
```

Dependências e artefatos (`node_modules`, `dist`, coverage e `.env`) ficam fora do Git.

## World Management

A Etapa 07 adiciona WORLD_STATE_QUERY, WORLD_TIME_SET, WORLD_WEATHER_SET e
WORLD_ENTITY_SPAWN via `POST /api/v1/game-servers/:serverId/world/` nos sufixos
`state/query`, `time`, `weather` e `spawn`. Todas exigem Idempotency-Key, retornam
202 + Location e usam AdministrativeCommandService. Query não gera Audit;
mutations persistem Command + Audit atomicamente, antes de qualquer dispatch.

Coordinator/General Chief têm as quatro permissions World; Admin somente WORLD_READ;
Moderator/Support/DEV nenhuma. `GET /api/v1/world-operations/:commandId` exige a
permission dinâmica do tipo persistido; o endpoint genérico continua redacted.
Spawn usa exclusivamente o staff autenticado, IDs opacos e quantidade de 1 a 10.

A migration incremental WorldPermissions adiciona quatro permissions e nove grants:
35 permissions, 92 grants, sete migrations, sem tabelas locais World. Consulte
[contratos, matriz, validação e decisões](docs/world-management.md).

## VIP Store

A Etapa 08 persiste ofertas em `vip_offers`. Somente Coordinator administra o
catálogo em `/api/v1/admin/vip-store/offers`, com `VIP_STORE_READ` e a permission
`VIP_STORE_WRITE` já existente. Mutations e Audit são atômicos; mudanças de preço
registram valores anterior e novo. Preços são centavos inteiros em BRL.

O catálogo público `/api/v1/vip-store/offers` expõe somente ofertas ativas, com
DTO próprio, paginação e ordenação determinística. Rewards aceitos: ITEM, HORSE,
TITLE e SPELL, sem entrega automática, compra ou pagamento. O contrato HTTP pode
ser consumido futuramente pelo Electron, sem dependência dele no backend.

A migration incremental `1789870000000-VipStore` acrescenta a tabela e o grant de
leitura: oito migrations, 36 permissions e 93 grants. Consulte
[contratos, endpoints, auditoria e decisões](docs/vip-store.md).
