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

A Etapa 04 adiciona `1789840000000-AdminQueries`: insere DASHBOARD_READ e
GAME_BRIDGE_READ e seus 12 vínculos explícitos com as seis roles. Não altera
tabelas, entidades ou migrations anteriores. O rollback remove somente essas
permissions e seus vínculos; permissões anteriores são preservadas. O catálogo
passa a ter 31 permissions e 83 grants. `synchronize` continua false.

A Etapa 05 adiciona `1789850000000-CharacterResultLimit`: substitui somente
`game_command_results_size_check`, elevando `octet_length(result::text)` de 4096
para 65536 bytes e mantendo objeto JSONB ou NULL. Payload permanece em 4096 bytes.
Não cria tabelas nem altera grants ou migrations anteriores. `down` restaura 4096;
se houver resultados maiores, falha atomicamente, preservando os dados e o check
de 65536. Não trunca nem remove resultados. Testes exercitam rollback/reaplicação,
recusa de downgrade com dados grandes e ausência de diferenças schema/entities.

A Etapa 09 adiciona `1789880000000-ServerControl`: cria somente
`server_control_operations` (FKs para `game_servers` e `staff_users`, unicidade
`(game_server_id, idempotency_key)` e `correlation_id`, checks de tipo, status,
timestamps e erro, três índices). Permissions `SERVER_*` e grants já existiam
desde AuthRbac; nada é alterado neles. `down` remove a tabela e o histórico de
operações. Detalhes em `docs/server-control.md`.

A Subetapa 10.1 adiciona `1789890000000-PlayerAccounts`: cria `players` (status
ACTIVE/SUSPENDED/BANNED com default ACTIVE e display_name não vazio) e
`player_identities` (FK para `players`, sem cascade; `UNIQUE(provider,
provider_subject)`; provider DISCORD/STEAM; subject não vazio; índice por
player). Não há relação com `staff_users`/`staff_sessions` nem alteração de
permissions, grants ou migrations anteriores. `down` remove `player_identities`
e `players`, com perda desses dados. Detalhes em `docs/player-services.md`.

A Subetapa 10.2 adiciona `1789900000000-GenericActor`. Em `audit_logs`, somente
colunas nullable (`actor_type`, `actor_player_id`, `actor_system_source`), o check
`audit_logs_actor_check` e um índice: nenhuma linha é atualizada e o trigger
append-only permanece. Em `game_commands`, `actor_type` e `idempotency_scope`
(NOT NULL, default `STAFF`, preenchendo o histórico sem reescrita),
`requested_by_player_id` com FK para `players`, `requested_by_system_source`,
`game_commands_actor_check` e a troca de `game_commands_idempotency_key` para
`UNIQUE(game_server_id, idempotency_scope, idempotency_key)`. `down` recusa
reverter se existirem dados PLAYER/SYSTEM; caso contrário restaura a constraint
global e remove as colunas. Detalhes em `docs/player-services.md`.

A Subetapa 10.3 adiciona `1789910000000-PlayerSessions`: cria somente
`player_sessions` (FK para `players`, digest SHA-256 do refresh token com check de
formato, `expires_at > created_at`, índice por player). Não guarda tokens de
provider, IP ou user agent e não se relaciona com `staff_sessions`. `down` remove a
tabela e encerra todas as sessões de player. Detalhes em `docs/player-services.md`.

A Subetapa 10.4 adiciona `1789920000000-PlayerCharacters`: cria `player_characters`
(FKs para `players` e `game_servers`, `UNIQUE(player_id, game_server_id,
character_external_id)`, índice único parcial de VERIFIED por servidor/character e
check de lifecycle) e `player_character_link_challenges` (FK para o vínculo, hash
único, índice único parcial de um challenge ativo por vínculo, checks de formato,
exclusividade consumido/revogado e expiração). `down` remove as duas tabelas e o
histórico de vínculos. Detalhes em `docs/player-services.md`.

A Subetapa 10.7 adiciona `1789930000000-Professions`: cria `character_professions`
(identidade do character por `game_server_id` + `character_external_id`, com FK
para `game_servers` e `UNIQUE`, independente dos vínculos; check do catálogo, XP bigint limitado, nível 1–100 e
check inteiro de coerência nível/XP) e `profession_experience_events` (FKs para a
profissão e o servidor, `UNIQUE(game_server_id, external_event_id)`, checks de
amount e id). `down` remove as duas tabelas e o progresso. Detalhes em
`docs/player-services.md`.

A Subetapa 10.8 adiciona `1789940000000-PlayerGroups`: cria `player_groups` (FK
para `game_servers`, status e coerência de `disbanded_at`), `player_group_members`
(FKs para group e vínculo, índices únicos parciais de uma membership ativa por
vínculo e um leader ativo por group) e `player_group_invites` (FKs, status,
`responded_at` nulo apenas em PENDING, índice único parcial de um convite pendente
por group e target). `down` remove as três tabelas e o histórico de groups.
Detalhes em `docs/player-services.md`.

A Subetapa 10.9 adiciona `1789950000000-PlayerGuilds`: cria `player_guilds` (FK
para `game_servers`, `UNIQUE(id, game_server_id)`, checks de status, de
`disbanded_at` e do nome, índice único parcial do `name_key` por servidor entre
guildas ACTIVE), `player_guild_members` (FK composta `(guild_id, game_server_id)`
para a guild, identidade `character_external_id` sem FK para vínculos, índices
únicos parciais de uma membership ativa por character e um MASTER ativo por guild)
e `player_guild_invites` (FK composta, status, `responded_at` nulo apenas em
PENDING, índice único parcial de um convite pendente por guild e target). `down`
remove as três tabelas e o histórico de guildas. Detalhes em
`docs/player-services.md`.

A Subetapa 10.12 adiciona `1789960000000-Economy`: cria `economy_accounts` (FK para
`game_servers`, CHECK de moeda GOLD, shape CHARACTER/SYSTEM e limites de saldo,
índices únicos parciais por character e por system key), `economy_transactions`
(Generic Actor com CHECK de scope, `UNIQUE(game_server_id, idempotency_scope,
idempotency_key)`, SYSTEM_* só por ator SYSTEM) e `economy_entries` (FKs compostas
`(id, game_server_id, currency)` para transaction e account, amount ≠ 0). Triggers:
ledger append-only, balanço (soma zero, ≥ 2 legs) verificado no COMMIT por
constraint triggers deferred, balance projetado a partir das entries e protegido
contra escrita direta e remoção. `down` recusa reverter se o ledger não estiver
vazio. Detalhes em `docs/player-services.md`.

A Subetapa 10.13 adiciona `1789970000000-PlayerTrades`: amplia
`economy_accounts_owner_check` com o system key `TRADE_ESCROW` (a migration da
10.12 não muda) e cria `player_trades` (partes distintas, CHECK de lifecycle,
trigger de transições só para frente e sem DELETE), `player_trade_offers`
(`UNIQUE(trade_id, side)`, gold e versão), `player_trade_items`
(`UNIQUE(offer_id, item_external_id)`, quantidade), `player_trade_currency_escrows`
(`UNIQUE(trade_id, character_external_id)`, FKs para as transactions de reserva e
resolução, resolução única), `player_trade_requests` (idempotência por scope de
player, FK de trade deferred) e `player_trade_settlement_events` (evento único por
servidor e por trade). Triggers congelam offers/items fora de NEGOTIATING e tornam
requests/eventos append-only. `down` recusa reverter com trades ou TRADE_ESCROW
existentes. Detalhes em `docs/player-services.md`.

A Subetapa 10.14 adiciona `1789980000000-PlayerMarketplace`: amplia
`economy_accounts_owner_check` com o system key `MARKET_ESCROW` (as migrations da
10.12 e da 10.13 não mudam) e cria `player_marketplace_listings` (termos
imutáveis, sem listing gratuita, CHECK de lifecycle, ACTIVE exige evento de
custódia, trigger de transições só para frente e sem DELETE),
`player_marketplace_purchases` (`UNIQUE(listing_id)`: uma compra efetiva por
listing), `player_marketplace_currency_escrows` (`UNIQUE(purchase_id)`, FKs para
as transactions de reserva e resolução, resolução única),
`player_marketplace_requests` (idempotência por scope de player, FK de listing
deferred) e `player_marketplace_custody_events`/`player_marketplace_settlement_events`
(evento único por servidor e por listing/purchase, append-only). `down` recusa
reverter com listings ou MARKET_ESCROW existentes. Detalhes em
`docs/player-services.md`.

A Subetapa 10.15 adiciona `1789990000000-PlayerChat`: `player_chat_messages`
(CHECK de shape por canal, conteúdo 1..500 code points sem controles,
`expires_at > created_at`, trigger de insert que amarra sender e canal ao
servidor), `player_chat_direct_threads` (par canônico de ownership links,
`UNIQUE`, mesmo servidor) e `player_chat_requests` (idempotência por scope de
player, FK deferred com `ON DELETE CASCADE`). Triggers bloqueiam UPDATE e TRUNCATE
e só permitem DELETE de linhas expiradas, deixando a purga de retenção futura
possível. `down` recusa reverter com mensagens ou threads existentes. Detalhes em
`docs/player-services.md`.
