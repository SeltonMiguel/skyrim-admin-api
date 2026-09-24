# Etapa 08 — VIP Store

Catálogo persistido no backend, separado das operações sobre personagens. Criar,
editar ou ativar ofertas não envia commands nem executa rewards no Skyrim.

## Modelo e valores

`vip_offers` contém UUID id, code, name, description, price_minor, currency,
active, sort_order, rewards JSONB e timestamps de criação/edição.

- **code**: trim/lowercase, 3–64 caracteres, padrão
  `^[a-z0-9][a-z0-9_-]{2,63}$`. Único no PostgreSQL e imutável pela API/serviço.
  Desativar preserva UUID e reserva code; não há DELETE administrativo.
- **name**: texto trimado, não vazio, até 100 unidades UTF-16, sem controles ou LF.
  **description**: texto trimado até 2000 unidades UTF-16; admite vazio e LF.
  Ambos exigem Unicode válido e são texto literal.
- **priceMinor**: inteiro entre **0 e 2147483647**, coluna PostgreSQL `integer`.
  Unidade: centavo; `1990` significa R$ 19,90. Frações, strings, negativos e null
  são rejeitados, sem coerção ou arredondamento.
- **currency**: obrigatória, explicitamente **BRL**; sem conversão cambial.
- **active**: booleano, padrão **false**; alteração posterior por endpoint próprio
  com estado explícito, sem toggle.
- **sortOrder**: inteiro de 0 a 1000000, padrão 0. Listagens ordenam por
  `sortOrder ASC, code ASC`; code único resolve empates deterministicamente.
- **rewards**: de **1 a 20** definições fechadas. O validador limita o JSON da
  oferta a 32768 bytes, considerando também sua representação como JSONB.

## Rewards suportados

| type | Campos obrigatórios além de type |
| --- | --- |
| ITEM | itemId, quantity inteira de 1 a 10000 |
| HORSE | horseId |
| TITLE | titleId |
| SPELL | spellId |

Reutilizam conceitos/validadores de Character Management, sem characterId ou alvo
de execução. IDs são opacos, trimados, não vazios, até 128 unidades UTF-16, com
Unicode válido e sem controles C0/C1. Não há catálogo local para verificar sua
existência no jogo. Tipos desconhecidos e campos extras, como script, rawCommand,
payload ou quantity em HORSE, são rejeitados.

## Administração e permissions

Prefixo: `/api/v1/admin/vip-store/offers`. Exige JWT de staff e permissions
atuais. Somente COORDINATOR recebe VIP_STORE_READ e VIP_STORE_WRITE; GENERAL_CHIEF,
ADMIN, MODERATOR, SUPPORT e DEV não recebem nenhuma delas. A escrita reutiliza a
permission existente; somente a leitura é nova. Os serviços também verificam
permissions antes de acessar persistência/Audit.

| Método e sufixo | Permission | Comportamento |
| --- | --- | --- |
| GET / | VIP_STORE_READ | Lista ativas e inativas, paginadas |
| GET /:id | VIP_STORE_READ | Detalhe por UUID |
| POST / | VIP_STORE_WRITE | Cria oferta; retorna 201 |
| PATCH /:id | VIP_STORE_WRITE | Edita campos fornecidos; retorna 200 |
| PATCH /:id/active | VIP_STORE_WRITE | Body `{ "active": true/false }`; retorna 200 |

Criação exige code, name, description, priceMinor, currency e rewards;
active/sortOrder são opcionais. Exemplo de body:

```json
{
  "code": "vip_gold",
  "name": "VIP Gold",
  "description": "Benefícios do pacote",
  "priceMinor": 1990,
  "currency": "BRL",
  "rewards": [{ "type": "ITEM", "itemId": "opaque:item", "quantity": 3 }]
}
```

PATCH aceita somente name, description, priceMinor, currency, sortOrder e rewards.
Campos ausentes são preservados; rewards substitui a lista inteira. Body vazio,
null e campos extras são rejeitados; code e active não são aceitos nesse PATCH.
DTO administrativo acrescenta active, sortOrder, createdAt e updatedAt ao público.
Erros: 400 input inválido, 401 sem autenticação, 403 sem permission, 404 oferta
inexistente, 409 code duplicado e 503 falha de Audit.

## Catálogo público e futuro consumo pelo Electron

`GET /api/v1/vip-store/offers` e `GET /api/v1/vip-store/offers/:code` são públicos,
anônimos e independentes da autenticação de staff. Filtram active=true;
oferta inativa/inexistente no detalhe retorna 404. Respostas usam
`Cache-Control: no-store`. Autenticação de player não está implementada.

Listagens públicas e administrativas aceitam somente page (padrão 1, máximo
1000000) e limit (padrão 20, máximo 100), inteiros positivos. Retornam
`{ items, total, page, limit, totalPages }`; página além do total tem items vazio.
Total público conta somente ativas. A paginação não representa snapshot entre
chamadas concorrentes de edição do catálogo.

DTO público contém exclusivamente **id, code, name, description, priceMinor,
currency e rewards**, sem active, sortOrder, timestamps ou metadata administrativa.
Presenter usa allowlist e copia rewards. A ordenação vem pronta do backend.
Electron poderá consumir o contrato HTTP versionado e os schemas de
`/docs-json`, sem dependência de Electron no backend. O consumidor deve renderizar
name/description como texto e formatar priceMinor em BRL apenas para exibição.

## Audit e concorrência

Create/update/active usam `AuditService.execute`: mutation e Audit SUCCESS na
mesma transação e EntityManager. Falha ao persistir Audit gera rollback da
mutation. GET não gera Audit. Actions: VIP_OFFER_CREATED, VIP_OFFER_UPDATED,
VIP_OFFER_ACTIVATED e VIP_OFFER_DEACTIVATED. ResourceType VIP_OFFER e resourceId
UUID da oferta; actor vem da autenticação.

Metadata selecionada explicitamente:

- Criação: code, priceMinor, currency, active e rewardCount.
- Edição: code e changedFields; quando preço/moeda muda, previousPriceMinor,
  newPriceMinor, previousCurrency e newCurrency; quando rewards muda,
  previousRewardCount e newRewardCount.
- Ativação/desativação: code, previousActive e newActive.

Não são copiados rewards completos, descrições, tokens ou bodies arbitrários.
Edição sem alteração efetiva ainda audita com changedFields vazio.
Update/active usam lock pessimista da linha para preservar alterações concorrentes
e o valor anterior correto. Criações concorrentes com code normalizado igual são
resolvidas por UNIQUE: uma retorna 201, a outra 409.

## Migration e validação

`1789870000000-VipStore` é incremental: cria tabela, constraints, índice
(active, sort_order, code), VIP_STORE_READ e seu grant a COORDINATOR. Não modifica
migrations anteriores nem recria VIP_STORE_WRITE. Total: **8 migrations,
36 permissions e 93 grants**. Down remove apenas objetos/grant novos; ao remover
a tabela VIP, remove também seus dados.

O banco impõe unicidade/formato de code, preço não negativo em integer, BRL,
limite de sortOrder, nome não vazio e formato/tamanho externo da lista de rewards.
A validação estrita de cada reward e a imutabilidade de code pertencem à API e
ao serviço; não há trigger que impeça alterações diretas privilegiadas desses
dados. `synchronize=false` e `migrationsRun=false`; apply é explícito.

Validação direta, com PostgreSQL real e schemas isolados nos e2e:

```bash
npm run lint
npm run build
npm test
TEST_DATABASE_INTEGRATION=true npm run test:e2e
npm run migration:run
git diff --check
npx tsc --noEmit --incremental false
```

A suíte VIP cobre seis roles, catálogo ativo, DTO público, Swagger, limites,
imutabilidade, concorrência, Audit/rollback, apply/rollback/reapply e zero schema
diff. Sem a flag de integração, suítes de banco são omitidas e a validação está
incompleta.

Validação concluída: 401 unitários (21 suítes) e 454 e2e (10 suítes) aprovados,
incluindo 58 e2e VIP, sem skips. Lint, build, TypeScript e diff-check passaram.
Migration aplicada no banco configurado: oito aplicadas, nenhuma pendente e
zero schema diff nas duas direções, com synchronize=false. Migrations anteriores
e dependências permaneceram intactas.

Fora desta etapa: compra, checkout, order, pagamento, saldo, assinatura,
entitlement, entrega/execução automática de rewards, frontend Electron e adapter
real Skyrim. Nenhuma dessas operações é inferida da ativação de uma oferta.
