# Performance harness (12.6)

Execute da raiz, Node 24 e PostgreSQL 16 local, depois de `npm ci` e
`npm run build`. Não exige k6/autocannon global. Usa `pg`, `ws`, Nest testing
bootstrap e o runtime compilado nas versões do lockfile. Não faz parte de
`npm run test:e2e` e nunca recompila enquanto uma medição está rodando.

```sh
npm run perf:smoke
npm run perf:baseline -- --replicas=1
npm run perf:baseline -- --replicas=2
npm run perf:saturation -- --replicas=2 --concurrency=128
npm run perf:load -- --replicas=2 --scenario=commands --latency=250
npm run perf:load -- --replicas=2 --scenario=domain,work,economy,realtime,churn,limiter,bus,backlog
npm run perf:soak
node scripts/perf/report.mjs /tmp/skyrim-perf-... > /tmp/performance-summary.md
```

`--profile`, `--duration` (segundos por degrau/cenário), `--concurrency`,
`--replicas` (1 ou 2), `--scenario` (lista separada por vírgula), `--seed`,
`--pool`, `--latency` (ms no FakeAgent), `--cooldown`, `--endpoints=admin,characters` (filtro de reads) e `--output`.
Equivalentes `PERF_PROFILE`, `PERF_DURATION`, `PERF_CONCURRENCY`,
`PERF_REPLICAS`, `PERF_SCENARIO`, `PERF_SEED`, `PERF_POOL`, `PERF_LATENCY`,
`PERF_COOLDOWN`, `PERF_OUTPUT`. Flags vencem env. `soak` exige duas réplicas
e pelo menos 600 segundos reais; cooldown padrão 125 segundos para observar
o TTL de 60 s mais o intervalo de cleanup de 60 s.

Perfis: smoke 2 s, baseline 10 s, load 10 s, saturation 10 s **por degrau**,
soak 600 s. Concorrências padrão 1/4/16/128/4 respectivamente. O soak dosa
leituras por lane (20 ms) e um produtor independente de trabalho real.
Configuração de segurança e intervalos do runtime permanecem nos defaults.

## Isolamento

Só aceita `PERF_DB_HOST=127.0.0.1|localhost|::1`. Defaults de acesso:
`PERF_DB_PORT=5434`, `PERF_DB_USERNAME=skyrim`, `PERF_DB_PASSWORD=skyrim`.
A role precisa de CREATE DATABASE. Ignora `DB_DATABASE` e não carrega `.env`.
Cria um **novo** `skyrim_perf_<16 hex aleatórios>`; se CREATE falhar, não
remove nada. Aplica migrations, verifica diff e remove somente o banco que
esta execução criou, depois de fechar réplicas e pools. Não usa DROP SCHEMA,
TRUNCATE nem DROP em bancos existentes. Em SIGKILL pode restar um banco com
esse prefixo: veja `environment.json`, confirme que não tem processos vivos
e remova manualmente. SIGINT/SIGTERM tentam drenar e limpar.

`replica.mjs` só inicia com IPC de um pai e nome de banco isolado. Os RPCs são
operações fechadas de fixture/diagnóstico, não endpoints HTTP nem código
incluído em `dist/`. Cada réplica tem processo, pool, event loop e métricas
próprios. Não há mock de locks, leases, bus, SQL, guard, JWT ou Argon2.
Apenas o I/O externo do provider Discord é simulado (token endpoint + user
endpoint); validação do provider, exchange HTTP e sessão são reais. Os tempos
não incluem a rede/serviço Discord real.

Dados lógicos (contas, caracteres, itens, valores e chaves) derivam da seed.
UUIDs/timestamps gerados pelo domínio continuam reais. Duas fontes loopback
representam Agents e fontes loopback distintas representam clientes; não se
forja X-Forwarded-For nem se aumenta/resetam os limites de segurança.

## Workloads e interpretação

- `reads`: health, readiness, dashboard Staff, discovery Player, personagens,
  conta Player e fila operacional paginada. Tokens obtidos uma vez via HTTP.
  Saturation continua a baseline com C=8,16,32,64,128,256 até o teto escolhido e para por erro,
  lag, pressão de memória ou colapso de latência sem ganho proporcional.
- `auth`: login Staff em rajadas 1/4/8/16, exchange Player e refresh separado;
  mantém rotação single-flight. Sempre distingue 429 de throughput aceito.
- `commands`: degraus C=1/4/8 até o teto solicitado; HTTP → worker → Agent → ACK/RESULT; Agent rápido ou com atraso
  definido. Em MULTI o HTTP chega em B e o Agent vive em A. Guarda submit e
  timestamps persistidos; journal executa uma vez por commandId.
- `control`: criação concorrente, 409 de operação já ativa separado; timeline
  created/claim/send/receive/notAfter/resultado. At-most-once, sem reenvio.
- `contention`: comandos/controle junto de reads C=0/8/32, curtos e controlados.
- `domain`: aplicação, duplicata e duplicatas concorrentes com eventId fixo;
  confirma receipt único. O resultado normal inclui a criação HTTP do work.
- `work`: lotes de 1 e 50 itens de custódia, tamanho da resposta, notifier
  ativo; criação do lote via serviço real evita confundir quota Player com
  custo da leitura WORK_SYNC.
- `economy`: trade com item + GOLD, compra ou cancel/release de marketplace,
  grant VIP e worker real. A+B rodam seus workers simultaneamente.
- `realtime`/`churn`: autenticação real, Player e Staff, publicação em B e
  sockets em A, autorização por entrega, churn com remoção das leases.
- `limiter`: provider PostgreSQL A+B, 100 chamadas na mesma chave devem
  admitir exatamente 10; carga mesma chave vs conjunto de 1000 chaves.
  Não compara memory e PostgreSQL como garantias equivalentes.
- `bus`: wake-ups de realtime, queda **somente** da conexão LISTEN deste
  banco, reconexão e novo recebimento (nenhuma promessa de replay).
- `backlog`: collector real sobre dataset vazio e histórico terminal,
  EXPLAIN somente se alguma coleta exceder 100 ms. Sem índice especulativo.
- `mixed`: leituras, GameCommands, ACK/RESULT, WORK_SYNC, DOMAIN_EVENT,
  economia/VIP, ServerControl, refresh moderado e realtime/churn em MULTI.

Carga é closed-loop: ao degradar, cada lane espera a resposta. Throughput é
capacidade **observada**, não uma taxa de chegada garantida; não se esconde
coordinated omission com alegação de SLA. Warm-up/JIT e coleta aparecem nas
séries. Não rode testes, builds ou outras cargas junto da medição. O teto do
gerador na mesma máquina pode limitar endpoints baratos antes do servidor.
O benchmark usa a mesma máquina para DB, gerador e réplicas; isso não prova
scaling horizontal de hardware.

## Artefatos

Cada execução usa diretório novo, padrão `/tmp/skyrim-perf-*`. Alternativa
local `.perf-results/` está ignorada pelo Git. `run.lock` impede sobrescrever
uma execução. Não versionar JSONL, logs ou profiles brutos.

- `environment.json`: commit, Node, PostgreSQL, CPU/RAM, topologia e defaults.
- `stages.json`: throughput total/aceito, p50/p95/p99/max, 4xx/429, 5xx/erros.
- `samples.jsonl`: scrape Prometheus por réplica, CPU/RSS/heap/handles,
  event loop, pool, workers/backlog, bus, limiter, slow-client drops;
  contagens SQL efêmeras e in-flight, load/free RAM da máquina e gerador.
- CPU/memória do container PostgreSQL via cgroup v2 quando disponível;
  `PERF_PG_CONTAINER` identifica o container local. Ausência = `null`, não 0.
- `commands.json`, `controls.json`, `timeline.json`, `realtime-*.json`,
  `work-*.json`, `backlog.json`, `bus.json`, `agent-journal.json` e `mixed.json`: evidência por cenário.
- `result.json`: schema/migrations e invariantes; falha gera `failure.json`
  e exit não zero. Cooldown não força GC nem limpa tabelas à mão.

Counters de banco globais não são somados entre réplicas. Métricas do runtime
não recebem labels por id. Ids na timeline são só diagnósticos brutos locais.
A instrumentação de tick/envio existe apenas no bootstrap do harness, com
buffer limitado; não é um profiler permanente no backend.

## Regressão dos flakes

O hook `scheduler-delay.mjs` atrasa **somente** continuações dos sleeps de
200/400 ms históricos, mantendo worker/deadlines reais. Reproduz uma
premissa frágil do teste; não simula CPU do PostgreSQL nem prova um stall de
produção. Atraso padrão desligado. Exemplo após build:

```sh
NODE_ENV=test DB_PORT=5434 TEST_DATABASE_INTEGRATION=true \
PERF_TIMER_DELAY_MS=1000 \
node --env-file=.env.example --import ./scripts/perf/scheduler-delay.mjs \
  --experimental-vm-modules node_modules/jest/bin/jest.js \
  --config test/jest-e2e.config.cjs --runInBand \
  --runTestsByPath test/server-control-agent.e2e-spec.ts test/game-command-agent.e2e-spec.ts \
  --testNamePattern='keeps one non-terminal|retries with the same identity'
```

Veja números, causalidade, mudanças e limitações em `docs/performance.md`.

## Continuação 12.6A

Checkpoint, resultados e limitações: `docs/performance.md`; tabelas completas
por degrau: `docs/performance-12.6a-measurements.md`. Nenhum timeout, índice,
limite de segurança ou configuração de produção foi alterado.

A máquina WSL apresentou saltos do relógio civil de aproximadamente 1,5 s.
Os perfis finais usam `process.hrtime.bigint()` para correlacionar os eventos
do Agent e das réplicas no mesmo host. Durações persistidas no PostgreSQL
continuam baseadas em relógio civil; não misturar os dois relógios. Os primeiros
artefatos da retomada têm `performance.now()` relativo a cada processo, sem
subtração válida entre processos. CPU por stage usa deltas de CPU / duração
monotônica; CPU calculada dos scrapes antigos com Date.now é aproximada.

Diagnóstico opt-in SQL (somente banco descartável, não incluído na baseline):

```sh
PERF_SQL_PROFILE=1 node scripts/perf/run.mjs --profile=load --replicas=1 \
  --concurrency=32 --duration=8 --pool=10 --endpoints=admin,characters \
  --scenario=reads,sql
```

`sql-profile.json` agrega contagem e tempo de chamadas TypeORM (inclui espera
pela conexão, não é tempo de CPU SQL). `hot-queries.json` guarda EXPLAIN das
cinco SELECTs mais custosas observadas com >100 execuções; não roda DML.
Instrumentação afeta throughput: comparar somente pares com o mesmo profiling.
O pool 12 foi um experimento isolado, não um novo default.

Regressões em banco recém-criado e removido pelo runner (não usar banco dev):

```sh
node scripts/perf/flakes.mjs /tmp/skyrim-perf-flakes-idle 0 \
  'keeps one non-terminal|retries with the same identity'
PERF_FLAKE_LOAD=32 node scripts/perf/flakes.mjs /tmp/skyrim-perf-flakes-load 1000 \
  'keeps one non-terminal|retries with the same identity'
node scripts/perf/flakes.mjs /tmp/skyrim-perf-flakes-suites 0
```

`PERF_FLAKE_LOAD=0|8|32` adiciona readiness real concorrente somente enquanto
cada teste roda. `timeline.jsonl` registra T0–T5, pool, event-loop e scheduling;
`stdout.log`/`stderr.log` conservam diagnóstico e resultado Jest. Depois da
correção não há o sleep histórico alvo nos dois testes; a injeção de timer
continua útil para a comparação com a evidência anterior, mas a contenção
real é medida separadamente. Defaults da aplicação ficam intactos.

Fechamento 12.6A: novos logs e checkpoint sem secrets em
`/tmp/skyrim-perf-12.6/`; artefatos anteriores preservados em
`/tmp/skyrim-perf-126a-*`. `node --test scripts/perf/clock.test.mjs`
valida independência do relógio civil. `clock.mjs` nunca define deadline
distribuído nem altera timestamps persistidos. O controle ServerControl final
registra commit, detecção pelo owner, claim autocommit, envio e recebimento.

## 12.6B.1

Rodar `npm run build` antes: réplicas importam `dist/`, e um `dist/` antigo mede
código antigo. O ServerControl publica em produção o hint `SERVER_CONTROL_WORK`
(sem payload); por isso `PERF_CONTROL_WAKE=1` foi aposentado e aborta a réplica
(duplicaria o hint). `PERF_CONTROL_HINT_DROP=1` descarta o hint de produção na
réplica (controle hint perdido / polling puro). A timeline registra
`control-hint-published|dropped|received`. `PERF_COMMAND_WAKE=1` continua como
experimento só de harness para GameCommand. Brutos persistentes podem ir para
`--output=.perf-results/<nome>` (ignorado pelo Git), já que `/tmp` não
sobrevive a reboot. Resultados em `docs/performance.md`, seção 12.6B.1.

## 12.6B.2

- `PERF_COMMAND_WAKE=1` aposentado (aborta a réplica): o GameCommand publica
  `GAME_COMMAND_WORK` em produção. `PERF_COMMAND_HINT_DROP=1` torna o anúncio
  de produção (wake local e hint do bus) um no-op na réplica: controle de
  polling puro em SINGLE e MULTI. Timeline: `command-hint-published|dropped|received`.
- `PERF_COMMAND_STEPS=1,2` escolhe os degraus do cenário `commands` (padrão
  `1,4,8`). Sem o estrangulamento do polling, lanes closed-loop demais por
  servidor passam do limite de mensagens do Agent (ACK + RESULT por comando) e
  o Agent é fechado com RATE_LIMITED.
- `PERF_LEAK_PACE_MS` pausa cada ciclo do cenário `leak`, mantendo o total de
  conexões abaixo do limite por IP.
- Execuções longas registram invariantes de segurança a cada 30 amostras
  (`invariants` em `samples.jsonl`). Com `PERF_EXPOSE_GC=1`, `cooldown-gc.json`
  guarda heap/handles/realtime pós-GC antes da carga e no início e no fim do
  cooldown.
- Correções: `db-skew` agora muda o locale para `en-US` (`pt-BR` é o default e
  um PATCH sem mudança não publica evento); `crash` espera o comando no Agent
  reconectado; `forward-owner-result` exige
  `SERVER_CONTROL_DELIVERY_WINDOW_MS` menor que o result timeout.
- O timeline das réplicas guarda até 20 mil eventos: num soak de 15 min as
  decomposições por evento são amostras parciais; o journal do Agent é completo.

Os 13 casos de clock: `.perf-results/12.6b2/run-clock.sh` não é versionado;
equivale a `PERF_CLOCK_CONTROL=1 PERF_CLOCK_CASE=<caso> node scripts/perf/run.mjs
--profile=baseline --replicas=2 --scenario=clock` para cada caso (com
`PERF_CLOCK_OFFSET_MS=±35000` em `db-skew`).
