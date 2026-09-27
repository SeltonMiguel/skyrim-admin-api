# Performance — checkpoints 12.6A, 12.6B.1 e 12.6B.2

## Resumo final da 12.6 (decisões)

**MEASURED_LOCAL_BASELINE — NOT A PRODUCTION SLA.** Um host local
compartilhado (WSL2, 16 CPUs), réplicas, gerador e PostgreSQL 16 na mesma
máquina. Tabelas: [12.6A](performance-12.6a-measurements.md) (baseline, ramp,
SINGLE × MULTI, pool) e [12.6B](performance-12.6b-measurements.md) (clock,
wake-ups, soak, churn, crash, overload). Este documento guarda interpretação e
decisões; as seções abaixo preservam método e ambiente de cada passada.

| Tema | Resultado | Decisão |
| --- | --- | --- |
| Primeiro limitante | CPU da réplica (thread JS, ~1,4 núcleo) com a fila do pool como sintoma; PostgreSQL em ~1,7 de 16 núcleos no overload | escalar réplicas antes de mexer no banco |
| `DB_POOL_MAX` | 10 → 12 deu ~4–5% (12.6A); no soak o pool esperou em 1/895 amostras | **10** |
| ServerControl non-owner | commit → owner p99 954 → 11,5 ms com hint `SERVER_CONTROL_WORK` | wake-up **KEEP**, polling de 1 s como fallback |
| GameCommand | created → reserved p99 344 → 22 ms (MULTI), 337 → 18,5 ms (SINGLE) com `GAME_COMMAND_WORK` | wake-up **KEEP**, polling de 500 ms como fallback |
| Janela de mensagens do Agent | step civil fechava Agent legítimo (−60 s) ou resetava a janela (+60 s) | relógio monotônico (process-local) |
| Leases, heartbeat, TTL/cleanup do bus, intervalos de worker | margens amplas; bus e limiter convergem a 0 | **inalterados** |
| Índices / migrations | nenhuma query surgiu como gargalo | **27 migrations**, nenhum índice novo |
| Rate limits de segurança | nenhum relaxado | inalterados |
| Correctness sob carga | 0 violações em load, soak, churn, crash, overload e 13 casos de clock | — |

**Contrato de relógio.** Durações locais: relógio monotônico. Timestamps
persistidos e deadlines distribuídos: relógio civil. Produção exige NTP/chrony
(ou equivalente) em réplicas, hosts dos Agents e PostgreSQL. Sob skew grande,
timeouts são percebidos cedo ou tarde e timestamps de réplicas diferentes podem
aparecer fora da ordem causal (`completed_at < created_at` observado com +35 s);
timestamps não ordenam causalidade entre réplicas. Detalhes em
`docs/multi-instance.md` §13.

**MEASURED_LOCAL_CAPACITY_CONSTRAINT — Agent frames.** O limite de mensagens do
Agent é 200 frames por 10 s por sessão; um GameCommand normal gera ~2 frames
(COMMAND_ACK + COMMAND_RESULT). Localmente, o teto efetivo de um Agent/servidor
ficou em ~9–10 GameCommands concluídos/s; acima disso o Agent é fechado com
`RATE_LIMITED`. Não é bug nem SLA, e o limite não foi aumentado. O wake-up só
tornou o teto visível: o polling nunca reduziu frames por comando. A 12.7 deve
medir o workload real do Agent/SKSE contra esse limite.

**Memória e recursos.** No unbounded memory/resource growth was observed during
the tested 15-minute mixed soak and 37,450 realtime churn cycles. O heap pós-GC
teve deriva sublinear (+~5 MiB no soak; ~0,5 MiB por rodada de churn no início,
~0,1–0,3 nas últimas), com curva desacelerando; nenhum objeto realtime retido
(registry, leases, tokens em 0), handles e sockets de volta ao baseline.
Observação de horizonte maior (horas/dias) fica para staging/produção.

**MEASURED_LOCAL_BASELINE — NOT A PRODUCTION SLA.**

Medição local em 26/09/2026; base `8b291c885efd723d05a113761fe46241decc2cf3`, branch `feature/skyrim-12-hardening-release`. Na 12.6A: sem commit/push, sem alteração de produção, timeout, índice ou security limit; soak longo não executado. As duas mudanças de produção posteriores (janela monotônica do Agent e wake-up do ServerControl) estão validadas em [12.6B.1](#126b1--validação-das-mudanças-de-produção).

## Retomada e método

Preservados `.gitignore`, scripts npm e os sete arquivos existentes em `scripts/perf/`: README, client, replica, report, run, scenarios e scheduler-delay. Smoke prévio considerado concluído. Os brutos anteriores não estavam em `/tmp`; a baseline histórica SINGLE C=4 (~1,2–1,7k/s, p99 ~4–5,3 ms) é informação do checkpoint, não revalidada. A divergência local justificou **um controle** SINGLE C=4 para comparar com a nova baseline MULTI.

Ramps HTTP C=8/16/32, 5 s/degrau, closed-loop; mesma seed e PostgreSQL, JWT obtido antes da leitura. Health/readiness separados. MULTI distribui reads A/B; mutations chegam em B com Agents em A. Só Discord externo simulado. Sem aquecimento separado: JIT e caches afetam os primeiros degraus. Os números não são SLA nem demonstram scaling linear. Gerador, réplicas, PostgreSQL e outros containers preexistentes compartilham a máquina.

## Ambiente

Node 24.18.0; PostgreSQL 16.14 (container Debian, loopback 5434); Intel Core 7 240H, 16 CPUs disponíveis, 15,43 GiB RAM; Linux WSL2 `6.18.33.2-microsoft-standard-WSL2`, x64. SINGLE=1 réplica, MULTI=2. Pool baseline=10 **por réplica**; LISTEN e observer adicionam conexões fora do pool da aplicação.

| Configuração | Valor observado |
| --- | --- |
| GameCommand worker / ACK / execution / pending | 500 ms / 5 s / 30 s / 60 s; 3 attempts |
| ServerControl worker / delivery / result / pending | 1 s / 10 s / 300 s / 30 s |
| Agent heartbeat / timeout / inflight | 10 s / 30 s (fencing de ownership) / 32 por servidor |
| Agent messages / notifier | 200 por 10 s / 2 s |
| VIP worker / metrics collector | 2 s / 15 s |
| Realtime lease TTL / renew | 60 s / 20 s |
| Bus TTL / cleanup | 60 s / 60 s |
| DB connect / query / statement timeout | 5 s / 5 s / 10 s |

## Relógios e validade dos dados

Foram observadas descontinuidades entre relógio civil e monotônico: em SINGLE load, 2.004 ms civis corresponderam a 501,4 ms monotônicos (+1.502,6 ms). Em MULTI ambos os processos registraram saltos ~1,5 s equivalentes. Portanto os picos de “worker delay” calculados originalmente por Date.now **não provam scheduler delay**. O event-loop máximo amostrado não mostrou stall equivalente nesses intervalos. O mecanismo de ajuste do relógio do host não foi determinado.

Harness final usa hrtime do host para T0–T5 e latência do bus/realtime, e duração monotônica para CPU e ticks. Tempos persistidos no DB e `notAfter` continuam civis, como em produção. Os brutos mais antigos têm performance.now relativo a cada processo; não subtrair timestamps entre processos nesses arquivos. Pequenas rajadas podem ter amostras insuficientes; não tratar ausência de amostra como capacidade zero.

## HTTP: baseline comparável e ramp

| Read | C | SINGLE/s | MULTI/s | S p95/p99 | M p95/p99 |
| --- | --- | --- | --- | --- | --- |
| admin | 4 | 619.62 | 917.92 | 8.51/10.09 | 5.48/6.68 |
| discovery | 4 | 618.46 | 936.15 | 8.27/9.72 | 5.18/6.10 |
| characters | 4 | 626.11 | 911.85 | 7.93/9.16 | 5.39/6.13 |
| profile | 4 | 861.12 | 1313.91 | 6.09/7.20 | 3.80/4.45 |
| queue | 4 | 727.44 | 1062.80 | 7.04/8.08 | 4.68/5.60 |
| admin | 8 | 613.95 | 1174.74 | 17.29/20.44 | 9.08/10.53 |
| admin | 16 | 712.70 | 1309.49 | 27.13/29.58 | 15.42/17.16 |
| admin | 32 | 703.99 | 1341.08 | 56.92/84.29 | 28.01/30.47 |
| discovery | 8 | 697.97 | 1266.68 | 15.53/18.24 | 8.10/9.12 |
| discovery | 16 | 708.79 | 1350.87 | 26.75/28.80 | 15.34/17.09 |
| discovery | 32 | 725.18 | 1349.89 | 49.68/52.97 | 27.72/31.38 |
| characters | 8 | 663.72 | 1281.49 | 15.72/18.04 | 7.94/9.10 |
| characters | 16 | 708.51 | 1331.58 | 27.46/31.26 | 15.61/17.77 |
| characters | 32 | 717.00 | 1374.95 | 51.78/59.59 | 27.63/32.08 |
| profile | 8 | 936.01 | 1729.35 | 11.37/13.87 | 6.06/7.10 |
| profile | 16 | 955.04 | 1816.60 | 22.00/28.93 | 11.54/13.24 |
| profile | 32 | 1023.24 | 1869.69 | 36.22/39.82 | 21.86/25.22 |
| queue | 8 | 723.53 | 1408.78 | 13.96/16.39 | 7.34/8.73 |
| queue | 16 | 725.27 | 1489.22 | 31.02/36.76 | 13.57/15.08 |
| queue | 32 | 773.39 | 1499.15 | 50.35/55.05 | 25.08/27.27 |

Knee aproximado: discovery/characters/profile/queue começam a achatar em C=8; admin em C=16. C=32 aumenta fila/latência com ganho marginal. Por isso não foi ampliada a ramp. Health MULTI ainda ganha throughput em C=32 e o gerador chega a ~0,97 núcleo: esse endpoint barato tem teto do gerador como candidato, não prova de saturação PostgreSQL. Reads úteis usam ~0,1–0,34 núcleo no gerador e ~1,1/2,2 na aplicação SINGLE/MULTI; o primeiro limite observado é por réplica e fila de pool, com custo PostgreSQL crescente. Não houve evidência de esgotar os 16 CPUs do host nem de que um índice isolado determine o platô.

## Auth, comandos e ServerControl

| Topologia | Cenário | C | úteis/s | p99 ms | 429 | 409 |
| --- | --- | --- | --- | --- | --- | --- |
| single-load | staff-login-1 | 1 | 2.35 | 185.22 | 0 | 0 |
| single-load | staff-login-4 | 4 | 8.89 | 215.86 | 0 | 0 |
| single-load | staff-login-8 | 8 | 11.30 | 199.61 | 12 | 0 |
| single-load | staff-login-16 | 16 | 13.85 | 195.29 | 42 | 0 |
| single-load | player-login | 4 | 14.52 | 31.46 | 0 | 0 |
| single-load | staff-refresh | 1 | 1.98 | 19.79 | 14 | 0 |
| single-load | player-refresh | 4 | 15.67 | 31.38 | 12 | 0 |
| single-load | gamecommand-fast-or-delayed | 1 | 1.97 | 454.78 | 0 | 0 |
| single-load | gamecommand-fast-or-delayed | 4 | 7.87 | 440.76 | 0 | 0 |
| single-load | gamecommand-fast-or-delayed | 8 | 15.16 | 444.91 | 0 | 0 |
| single-load | server-control | 8 | 47.05 | 63.07 | 0 | 57 |
| multi-load | staff-login-1 | 1 | 2.33 | 187.58 | 0 | 0 |
| multi-load | staff-login-4 | 4 | 8.67 | 229.04 | 0 | 0 |
| multi-load | staff-login-8 | 8 | 16.91 | 237.93 | 0 | 0 |
| multi-load | staff-login-16 | 16 | 21.51 | 416.30 | 19 | 0 |
| multi-load | player-login | 4 | 14.64 | 32.67 | 0 | 0 |
| multi-load | staff-refresh | 1 | 1.99 | 28.47 | 13 | 0 |
| multi-load | player-refresh | 4 | 15.63 | 29.94 | 12 | 0 |
| multi-load | gamecommand-fast-or-delayed | 1 | 1.92 | 576.58 | 0 | 0 |
| multi-load | gamecommand-fast-or-delayed | 4 | 7.88 | 420.33 | 0 | 0 |
| multi-load | gamecommand-fast-or-delayed | 8 | 15.18 | 438.85 | 0 | 0 |
| multi-load | server-control | 8 | 2.23 | 1041.57 | 0 | 238 |

Login Staff mede Argon2 separado dos reads. SINGLE pico de 4 verificações simultâneas (limite 4), com 54 rejeições por concorrência na sequência; MULTI mantém limite **por processo**, não limite global de 4. Player exchange inclui provider Discord validado com I/O externo simulado. Refresh usa rotação single-flight. Cargas paced/quotas não equivalem a capacidade máxima de autenticação. CPU/RSS/heap por estágio estão no anexo.

Fast Agent: SINGLE 192 e MULTI 193 GameCommands SUCCEEDED, todos na tentativa 1; p99 create→dispatch/dispatch→ACK/total persistidos 537/100/686 ms e 518/92/636 ms (ressalva de relógio civil). C=1/4/8 fica perto de 2/8/15 conclusões/s, influenciado pelo tick de 500 ms e pela espera por conclusão em cada lane. Não é teto aberto do backend.

Com Agent atrasado 250 ms, mais 147/140 comandos concluíram sem timeout/efeito duplicado; máximo simultâneo observado por Agent=4, abaixo de 32. Retry preserva identidade/payload no harness e é exercitado pelo teste focado (tentativas 1/2), não pelos workloads sem retry.

ServerControl fast: 241 sucessos SINGLE (~47/s, p99 63 ms) versus 12 MULTI non-owner (~2,2/s, p99 1.042 ms), com 409 de operação já aberta contabilizado separado. SINGLE pode despachar pelo caminho local da requisição; B depende do tick de A. A carga combinada C=32 elevou pool wait até 31 SINGLE e 10 MULTI; GameCommand/Control p99 combinado ~960/1.043 ms. Controles totais nos dois blocos fast: 320/29, sem reenvio. `controls.json` conserva created/claim/send/notAfter/receive/result e janela restante.

## Diagnóstico dos flakes e correção

Antes: idle passou 2/2. Injeção de +1.000 ms **somente nas continuações dos sleeps históricos** reproduziu 2/2 falhas: GameCommand esperou 1.200 ms após stale ACK e já estava na tentativa 3 (janela 600 ms); ServerControl esperou 1.401 ms e mandou o FakeAgent executar com notAfter vencido em 467 ms (janela 1 s). +450 ms reproduziu ServerControl com salto de relógio adicional: espera monotônica 851 ms, janela restante −1.568 ms; GameCommand passou nessa execução. Não atribuir esse segundo resultado só à duração do sleep.

Intervalo causal: GameCommand retarda ACK correto entre T3 (attempt 2 recebido) e T4/T5; ServerControl retarda perform/RESULT após frame recebido até ultrapassar notAfter. Não foi atraso autônomo do FakeAgent ou prova de timeout de produção insuficiente. Os saltos civis do host agravam as janelas curtas. Injeção sintética de continuação não representa CPU/DB contention.

Correções: stale ACK agora aguarda HEARTBEAT_ACK no mesmo socket serializado antes de conferir persistência; ServerControl aguarda DISPATCHED, dirige três passes reais de worker e usa uma barreira de heartbeat. As garantias de stale ACK ignorado, identidade do retry e at-most-once permanecem; timeouts de 600/1.000 ms intactos. Testes com tracing opt-in registram T0 created, T1 reserve, T2 send, T3 receive, T4 emit ACK e T5 persist, além de pool, lag e scheduling. Logs/frames não contêm tokens.

## Domain Event, WORK_SYNC e workers

Em SINGLE e MULTI: normal, duplicata e duplicatas concorrentes passaram, com receipt único; cargas paced respeitam o limite real do Agent. WORK_SYNC mediu 1 e 50 itens (batch perto do limite), drenando custódia depois. Trade, compra/cancelamento Marketplace e grants VIP foram executados com ledger/invariantes pós-carga. Métricas dos quatro workers registram ticks bem-sucedidos, sem error/skip observado nos blocos; backlog final de trabalho mutante=0. As duas réplicas executaram workers simultaneamente sem entrega VIP duplicada. Os 5.000 FAILED ao final dos blocos são histórico terminal **inserido como fixture**, não falhas do workload.

## Realtime, limiter, bus e collector

Realtime MULTI B→A: 21 sockets (16 Player + 5 Staff), 4536 eventos, 201.2/s, connect/auth p95/p99 17.03/20.43 ms; entrega p95/p99 23.63/39.65 ms. Carga dosada, sem alegação de saturação. Staff fence p95 19,73 ms; Player fence+fanout p95 4,42 ms; renovação ativa de lease observada em ~3,33 ms (amostra pequena). Zero slow-client drops/delivery failures; leases=0 após churn. RSS A/B 181/184→266/223 MiB; heap 69/70→100/85 MiB. Aumento curto não prova leak nem ausência de leak.

| Coordenação | C | úteis/s | p95/p99 ms | 429 |
| --- | --- | --- | --- | --- |
| limiter-same-key | 16 | 9.98 | 27.09/30.75 | 7765 |
| limiter-many-keys | 16 | 8306.37 | 2.48/3.53 | 0 |
| bus-wakeups | 1 | 18.52 | 6.21/8.88 | 0 |

Limiter PostgreSQL A+B admitiu exatamente 10 de 100 chamadas concorrentes na mesma key (assert do cenário), depois mesma key versus 1.000 keys. Garantia distinta do limiter em memória SINGLE. Bus: 93 wake-ups recebidos; latência {'count': 93, 'p50': 4.729153990745544, 'p95': 7.408710956573486, 'p99': 10.047368049621582, 'max': 10.047368049621582}. A queda intencional de uma conexão LISTEN foi recuperada e nova mensagem recebida; não se afirma replay. Tabelas após observação de cleanup: `{'bus': 0, 'buckets': 1, 'leases': 0, 'agents': 0, 'commands': 0, 'inflight': 0, 'connections': 9, 'lock_waiters': 0}`. O período sem carga de 125 s serve ao TTL, não é soak/leak assessment.

Collector: 20 coletas sobre dataset inicial e 20 após +5.000 comandos terminais. SINGLE p99 4,56→5,71 ms: barato no dataset medido, sem índice ou EXPLAIN especulativo. O cenário não prova comportamento com milhões de linhas.

## Hot paths observados, SQL e pool

1. Reads autenticados: throughput achata, p99 dobra e pool passa a esperar. No controle instrumentado C=32, pool10 mostrou espera em 100% das amostras de 20 ms em ambos os endpoints.
2. GameCommand: espera pelo worker de 500 ms domina o create→dispatch no workload dosado, sem sinal de ACK lento do Agent rápido.
3. ServerControl non-owner: espera pelo tick de 1 s do owner domina; SQL/Agent não explicam o degrau SINGLE→MULTI.
4. Auth Staff: Argon2 e admissão de 4 por processo; recusas são proteção esperada.
5. Realtime: reautorização Staff por socket é o maior custo observado no fanout curto, sem demonstrar knee.

No profiling opt-in, SELECTs TypeORM de PlayerSession, links de personagem, StaffSession e agregações do dashboard acumularam mais tempo (aprox. 4,4–5,1k chamadas/query). O cronômetro inclui aquisição de conexão e roundtrip. EXPLAIN ANALYZE BUFFERS **depois de identificar essas queries** retornou 0,016–0,071 ms/query no dataset local. Isso não demonstra uma query lenta por falta de índice; planos brutos em `pool-{10,12}/hot-queries.json`. Sem índices adicionados.

Experimento único próximo do baseline, mesmo profiling: pool10→12, admin 552→575/s, p99 95→88 ms; characters 604→637/s, p99 63→61 ms. Fila continua em ~99–100% das amostras. Ganho pequeno, sujeito a ruído e custo da instrumentação; pool permanece 10. **Candidatos 12.6B:** confirmar esse par sob workload misto mais longo; avaliar orçamento de espera/intervalos GameCommand e ServerControl non-owner se exigido pelo produto; reduzir custo repetido de autorização apenas preservando fencing. Não propor aumento de security limits, timeout ou índice a partir destes dados.

## Correctness, mudanças e validação

| Execução | Commands | Controls | máx Agent active | Invariantes | schema diff |
| --- | --- | --- | --- | --- | --- |
| coordination | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| delayed-1 | 147 | 59 | 4 | OK | {'up': 0, 'down': 0} |
| delayed-2 | 140 | 30 | 4 | OK | {'up': 0, 'down': 0} |
| monotonic-1 | 31 | 60 | 2 | OK | {'up': 0, 'down': 0} |
| monotonic-2 | 31 | 8 | 2 | OK | {'up': 0, 'down': 0} |
| multi-baseline | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| multi-load | 193 | 29 | 2 | OK | {'up': 0, 'down': 0} |
| multi-ramp | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| pool-10 | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| pool-12 | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| realtime-fixed | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| single-control-baseline | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| single-load | 192 | 320 | 2 | OK | {'up': 0, 'down': 0} |
| single-ramp | 0 | 0 | 0 | OK | {'up': 0, 'down': 0} |
| timeline-1 | 21 | 32 | 2 | OK | {'up': 0, 'down': 0} |
| timeline-2 | 20 | 6 | 2 | OK | {'up': 0, 'down': 0} |

Em cada execução mutante concluída: efeitos/resultados/receipts duplicados=0; ledger desequilibrado=0 e saldo divergente=0; nenhum Trade/Marketplace/VIP aberto indevidamente; sessões/leases=0 após encerramento. Inflight amostrado abaixo de 32, mais garantia transacional coberta pelas suítes focadas. Zero 5xx/transport nos workloads aceitos. Datasets finitos e amostragem não constituem prova exaustiva.

Mudanças novas: instrumentação e cenários no harness existente; runner `scripts/perf/flakes.mjs`; duas correções de sincronização nos e2e; tracing opt-in em `test/support`; documentação. Na 12.6A nenhum arquivo `src/` foi alterado; as mudanças de produção posteriores estão na seção 12.6B.1. A primeira execução realtime abortou antes do workload devido a cancelamento de socket CONNECTING no harness; evidência preservada em `realtime/failure.json`, banco próprio removido após confirmar zero conexões; repetição corrigida passou.

Validação funcional das duas suítes afetadas: 25/25 verdes; repetições finais e checks na seção de encerramento abaixo. Todos os brutos ficam em `/tmp/skyrim-perf-126a-*`, fora do Git; esses arquivos são efêmeros. [Tabelas de cada degrau](performance-12.6a-measurements.md) e [instruções do harness](../scripts/perf/README.md).

## Exclusivo de 12.6B/C

12.6B: tuning final justificado em ambiente com relógio estável; soak 10–30 min; leak/cooldown prolongado; overload. 12.6C: validação funcional/e2e completa, documentação final e release checklist. Nenhum desses itens foi declarado concluído aqui.

## Auditoria dos clock domains de produção

`BridgeClock.now()` retorna `new Date()`: relógio civil da aplicação, não monotônico.
A = app Date/new Date; B = PostgreSQL NOW; C = timestamp persistido originado
na app; D = timer/duração local; E = combinação. Persistir hrtime/performance.now
como deadline distribuído não é permitido e não foi implementado.

| Caminho | Criação e comparação observadas | Domínio / risco |
| --- | --- | --- |
| GameCommand ACK | `GameCommandDispatcher.reserve`: app now + 5 s, limitado por executionDeadline; retry/expiry com BridgeClock ou parâmetro SQL `:now` da app | A+C; skew app↔app pode antecipar/adiar retry |
| GameCommand execution | app now + 30 s, persistido; `GameCommandStore.expireExecution`/receiver com BridgeClock | A+C; sobrevive reconnect, mas não imune a clock step |
| GameCommand dispatch lease / pending | lease app + 2 s; pending createdAt explicitamente app e cutoff app −60 s; send watchdog usa setTimeout(1 s) | E: A+C para deadline; D para watchdog local |
| ServerControl delivery | createdAt e issuedAt explícitos da app; notAfter = issuedAt +10 s; FakeAgent compara com seu Date.now | A+C entre backend e Agent; skew entre hosts também importa |
| ServerControl result / pending | claim grava resultDeadline app +300 s; receiver/worker SQL usa `:now`/`:cutoff` gerados por BridgeClock; pending app −30 s | A+C; timers de polling/send são locais D |
| Agent freshness/ownership | connectedAt e lastHeartbeatAt app; fresh/owned e SQL `last_heartbeat_at > $cutoff` recebem app now −30 s | A+C; ownership UUID não depende do clock, validade da lease depende |
| Realtime cluster leases | acquire, expires_at, renew, limite de conexões e purge usam NOW() do mesmo PostgreSQL | B, com agendamento local D; salto civil do DB ainda pode expirar leases |
| Distributed bus / limiter | inserção/expiry/leitura/cleanup com NOW() do DB; limiter retorna remaining calculado no DB | B + agendamento D; não mistura relógio app no deadline |

Referências: `src/game-bridge/bridge-clock.ts`, `game-command-bus.ts`,
`game-command-dispatcher.ts`, `game-command-store.ts`, `game-command-receiver.ts`,
`game-connection.service.ts`; `src/server-control/server-control.service.ts`,
`server-control-dispatcher.ts`, `server-control-receiver.ts`;
`src/cluster/realtime-leases.ts`, `cluster-bus.ts`, `pg-rate-limiter.ts`.

Não foi encontrada comparação de deadline GameCommand/ServerControl criado pela
app contra NOW() do PostgreSQL nos caminhos normais auditados: SQL recebe o
horário da app como parâmetro. Apesar de as colunas terem defaults NOW(), as
criações reais examinadas sobrescrevem createdAt com BridgeClock. Defaults e
backfills de migrations/fixtures não devem ser confundidos com esse caminho.
Existe mistura **app B → timestamp persistido → app A** em MULTI, relevante
nas janelas de segundos, e backend → Agent no notAfter. JWT/timers de expiração
local realtime usam wall clock da app, separadamente da lease PostgreSQL.

### Classificação do salto civil

Sondagem somente leitura de 120 amostras, sem benchmark pesado:
`/tmp/skyrim-perf-12.6/clock-probe.json`. No mesmo intervalo a app avançou
+1.196,47 ms e PostgreSQL +1.196,90 ms além do monotônico; RTT nessa amostra
1,65 ms. Offset observado PG−app midpoint 0,045–5,602 ms, RTT máximo 13,18 ms
(incerteza da amostragem; não é certificação de sincronismo).

Classificação: descontinuidade civil comum ao ambiente host/VM nesta medição,
não skew isolado app↔DB e não stall equivalente do event loop. A causa exata
(NTP, VM/resume ou outra) não foi determinada. Os flakes têm uma fragilidade de
teste demonstrada, **e** deadlines reais baseados em wall clock permanecem
suscetíveis a steps/skew. Nenhum correctness failure de produção foi observado
nos workloads com defaults. Uma autoridade PostgreSQL consistente pode reduzir
skew entre instâncias, mas não elimina um step do próprio DB.

12.6B deve testar skew/steps controlados e examinar a disciplina de clock do
ambiente; avaliar autoridade de tempo consistente antes de alterar deadlines.
Não aumentar timeouts automaticamente e não persistir duração monotônica.

## Reconciliação explícita dos 192/193 comandos

Não existiu um comando faltante. A notação anterior significava duas execuções:
**SINGLE: 192 de 192 SUCCEEDED; MULTI: 193 de 193 SUCCEEDED**. Foram 189/190
submissões HTTP respectivamente, mais 3 comandos VIP em cada execução. O
workload é fechado por duração, não por quantidade: uma conclusão a mais no
MULTI é esperada. Ambos os journals têm uncompleted=[], attempts={1:total},
um efeito por commandId, pending_commands=0 e nenhum timeout do workload.

O último comando recebido na execução MULTI (o 193º),
`4fac4a9e-963f-4534-abbb-0c2fe93d2d82`, terminou SUCCEEDED, attempt=1,
frames=1, effects=1, RESULT ACK accepted=true, duplicate=false. Não era trabalho
em andamento, erro do harness ou bug de produção. Evidência preservada em
`multi-load/commands.json`, `agent-journal.json`, `result.json` sob o prefixo
`/tmp/skyrim-perf-126a-`. Os 5.000 FAILED históricos são fixture separada.

## Decomposição final ServerControl non-owner

Controle focado de 12 operações, sem repetir ramp:
`/tmp/skyrim-perf-12.6/control-decomposition/`. Hook após commit da transação,
início de dispatch no owner, início/fim do UPDATE de claim autocommit e send/
receive no mesmo relógio hrtime do host. São durações de ponta a ponta locais,
não CPU exclusiva do PostgreSQL.

| Intervalo | p50 ms | p99 ms |
| --- | ---: | ---: |
| HTTP enviado em B → commit | 21,02 | 39,26 |
| Commit → owner A começa dispatch | 898,05 | 953,68 |
| Dispatch → início claim | 1,67 | 4,75 |
| Claim autocommit | 3,09 | 13,44 |
| Fim claim → send | 1,22 | 2,94 |
| Send → FakeAgent recebe | 0,31 | 0,69 |
| HTTP → Agent, medido diretamente | 933,61 | 973,87 |

Percentis de componentes não são somáveis. A amostra é pequena; aqui p99 é o
máximo. O ~1 s é predominantemente latência arquitetural do polling no owner,
não transporte nem uma consulta isolada lenta. Sem bus wake-up/interval tuning
nesta medição 12.6A; o wake-up foi medido na 12.6B.1.

T0–T5 GameCommand também foi conferido monotonicamente (21 SINGLE/20 MULTI):
p95 create→reserve 331/332 ms; reserve→send 0,087/0,128 ms; send→receive
0,563/0,592 ms; receive→ACK emit 0,015/0,032 ms; emit→persist 19,50/22,55 ms.
T0 é retorno após commit de ActorCommandService.create, não só início da query.
Artefatos `/tmp/skyrim-perf-126a-timeline-{1,2}/commands.json`.

## Durações e pausas de teste

`clock.mjs` centraliza hrtime apenas para duração local. Stage, HTTP, pool/SQL,
worker, polling until, mixed workload e cooldown usam relógio monotônico.
Datas civis permanecem em envelopes, timestamps persistidos, notAfter e no
diagnóstico explícito de diferença entre clocks. Não foi executado soak.
O teste do helper substitui Date.now por uma função que lança erro e confirma
que duração/polling/timeout continuam funcionando.

Os dois testes históricos não contêm mais pause(N) para aguardar progresso:
barreira de heartbeat serializada para stale ACK e condição DISPATCHED/passagens
de worker para ServerControl. As pausas restantes nas duas suítes verificam
**ausência** de despacho/reenvio/capability/runtime/inflight; 1.100 ms força
explicitamente delivery expiry e 40 ms posiciona a corrida RESULT/deadline.
Esses dois últimos são cenários intencionais de deadline, não suposições de que
trabalho assíncrono terminou. Sucesso normal aguarda frame/ACK/estado real.

## Encerramento e recuperação de contexto

- Lint, build, `npx tsc --noEmit --incremental false` e `git diff --check`: verdes.
- `npm test -- --runInBand`: **703/703 testes, 45/45 suítes**.
- Duas suítes e2e afetadas completas: **25/25**, novamente verdes após tornar
  monotônicas também as esperas locais dos fixtures (deadlines do domínio intactos).
- Repetição focada: **3 normal + 3 injeção + 3 C=32**, dois testes por execução,
  **18/18 verdes**, maior tentativa observada=2 (esperada), nenhuma tentativa 3.
- Teste do helper monotônico: **1/1**; relatório final validado. Em artefatos
  antigos sem timestamps monotônicos o relatório final mostra CPU n/a, em vez
  de derivar duração civil. O anexo preserva os valores históricos explicitamente
  rotulados aproximados; não são nova medição.
- Todos os workloads concluídos e o controle de decomposição passaram os
  invariantes. Na 12.6A: nenhuma mudança de produção, migration, timeout ou limit
  (12.6B.1 altera `src/`; ver abaixo).
- E2e completo, soak e tuning final **não executados**.

Checkpoint machine-readable sem secrets:
`/tmp/skyrim-perf-12.6/checkpoint-12.6a.json`. Checks/logs finais e nove repetições
no mesmo diretório. Todos os brutos anteriores continuam preservados no prefixo
`/tmp/skyrim-perf-126a-*`; não usar a baseline histórica sem seu artefato como
comparação direta com esta retomada.

A auditoria de bancos encontrou `skyrim_perf_9ced074b5b18e2f3`, sem conexões,
com dados anteriores à retomada: 247 GameCommands SUCCEEDED e 16 controles
SUCCEEDED, últimos criados às 05:55 UTC, enquanto esta retomada iniciou medições
às 15:25 UTC. Não há artefato desta sessão que o identifique como banco criado
por ela. Foi inspecionado em transação READ ONLY e preservado, sem remoção de
trabalho anterior. Nenhum banco das execuções atuais permaneceu ativo ou
pendente. Detalhes agregados em `unattributed-database.json`.

Os novos documentos/harness/helpers ainda estão untracked. `git diff --stat`
mostra apenas arquivos já rastreados; o status completo foi guardado no checkpoint.
Sem commit/push e sem troca de branch.

## 12.6B.1 — validação das mudanças de produção

Medição local em 27/09/2026, mesma base `8b291c8`, mesmo host e PostgreSQL 16
(loopback 5434). **MEASURED_LOCAL — NOT A PRODUCTION SLA.** Soak, leak/cooldown,
overload, pool misto e tuning de lease/TTL **não** foram executados nesta passada.

### Recuperação

O desligamento abrupto apagou `/tmp`: os brutos da 12.6A
(`/tmp/skyrim-perf-126a-*`, `/tmp/skyrim-perf-12.6/`) não existem mais e as
tabelas acima são o único registro. Nenhum resultado 12.6B anterior à queda foi
persistido. O `dist/` existente era anterior às mudanças em `src/`, então
qualquer execução do harness antes da queda mediu o código antigo. Tudo abaixo
roda depois de `npm run build`. Banco residual `skyrim_perf_ed8c8882cc45a681`
(execução de ~2 min às 00:36–00:39 local, só eventos `REALTIME`, 97 buckets,
nenhum comando) foi inspecionado em READ ONLY e preservado, como o
`skyrim_perf_9ced074b5b18e2f3` anterior. Os brutos desta passada ficam em
`.perf-results/12.6b1/` (ignorado pelo Git, fora de `/tmp`).

O relógio civil do host continuou saltando: +0,8 a +1,7 s por estágio de
20–60 s. As durações abaixo usam `process.hrtime` do host.

### A. Janela local de mensagens do Agent: relógio monotônico

Mudança: `AgentGateway` mede a janela de rate limit de mensagens
(`windowStart`/`windowCount`, por socket, em closure) e a cadência do sweep de
sessões STALE (`lastDbSweep`, campo da instância) com `performance.now()`.

Por que monotônico é o relógio certo: as duas grandezas são **duração local do
processo**. Não são persistidas, não são comparadas com timestamps do
PostgreSQL, não cruzam instâncias e não sobrevivem a restart. O sweep em si
continua decidindo pelo `last_heartbeat_at` persistido (relógio civil, como
antes), e o valor inicial `-Infinity` mantém o primeiro sweep e a primeira janela
imediatos. Nenhum deadline distribuído (ACK/execução GameCommand, `notAfter`/
resultado ServerControl, heartbeat/ownership, leases, bus, limiter) foi alterado.

Evidência (e2e real contra PostgreSQL, limite de teste 40 frames/2 s, Agent
legítimo com 30 frames por janela, 3 janelas). OLD = gateway de `HEAD`
compilado num worktree temporário, com os mesmos testes:

| Caso | OLD (`Date.now`) | NEW (`performance.now`) |
| --- | --- | --- |
| sem step, janelas se renovam | passa | passa |
| step civil −60 s | **fecha 4012 RATE_LIMITED** um Agent legítimo | passa (HEARTBEAT_ACK) |
| step civil +60 s, Agent legítimo | passa | passa |
| step civil +60 s no meio da janela, 21 + 25 frames em < 2 s reais | **janela resetada, flood não detectado** | fecha 4012 RATE_LIMITED |
| controle: step −60 s no relógio que a janela lê (`performance`) | não afeta (lê `Date`) | fecha 4012 RATE_LIMITED |

Conclusão sustentada por teste: um step do relógio civil afetava a janela local
(nos dois sentidos: close falso para trás, bypass do limite para frente); a
janela monotônica elimina esse efeito. O controle mostra que o mecanismo é o
relógio lido, não o teste. Em produção um relógio monotônico não sofre step.
Brutos: `agent-clock/`, `agent-clock-reset/`, `agent-clock-OLD/`,
`agent-clock-OLD-probe/`.

### B. ServerControl wake-up

Mudança: quando a operação é criada numa instância sem o socket do Agent
(dispatch local retorna `HELD`), o service publica `SERVER_CONTROL_WORK` com
payload `{}` depois do commit. O `ServerControlWorker` de cada instância assina
o kind e chama `wake()`: no máximo um tick agendado, no máximo um rerun quando o
hint chega durante um tick, nada depois do shutdown. O tick relê a fila no banco
e usa o mesmo claim owner-aware; o polling de 1 s continua ativo como fallback.

Correctness:

- Unit (`lifecycle.spec.ts`, 6 testes): hints coalescem num tick; hint durante o
  tick gera exatamente um follow-up; pico de ticks simultâneos = 1; polling
  durante tick acordado é pulado, nunca sobreposto; polling continua sem hint;
  shutdown ignora hints e descarta o follow-up pendente.
- E2e MULTI: operação criada em B com o Agent em A. O hint chega, A acorda,
  claima e envia uma vez. Com o hint suprimido, o polling entrega, uma vez, sem
  `wake`. Todo `dispatchSafely` em B retorna `HELD` (B nunca claima), o payload
  publicado é sempre `{}`, e cada operação é entregue e executada uma vez.
- Benchmark: 0 envios duplicados, sends = operações em A, 0 sends em B.
  Timeline: nenhum tick sobreposto; as 2–6 chamadas por minuto que caíram
  durante um tick são retornos do guard `running` (< 0,1 ms, sem trabalho), e
  aparecem em `worker_ticks_skipped_total`.

Antes/depois (MULTI, HTTP em B, Agent em A, 2 lanes closed-loop por 60 s, duas
repetições por condição). "Hint perdido" suprime o hint de produção em B
(`PERF_CONTROL_HINT_DROP=1`), equivalente ao comportamento sem wake-up:

| Intervalo p50/p95/p99 ms | 12.6A (n=12) | hint perdido (n=122 / 121) | wake-up (n=886 / 888) |
| --- | --- | --- | --- |
| HTTP B → commit | 21,0/—/39,3 | 15,3/19,7/33,6 · 13,3/18,9/27,0 | 12,9/17,2/20,8 · 12,7/16,8/19,8 |
| commit → owner A inicia dispatch | 898/—/954 | 866/882/886 · 867/879/888 | **5,8/8,8/11,5 · 6,0/9,0/13,3** |
| claim autocommit | 3,1/—/13,4 | 1,8/4,6/5,2 · 1,9/4,5/5,3 | 0,9/1,6/2,5 · 0,9/1,5/2,4 |
| send → FakeAgent recebe | 0,31/—/0,69 | 0,17/0,43/0,52 · 0,18/0,36/0,51 | 0,12/0,24/0,47 · 0,13/0,22/0,39 |
| HTTP B → Agent recebe | 934/—/974 | 884/898/904 · 883/896/908 | **20,8/27,4/32,4 · 20,4/27,0/35,9** |
| operações concluídas/s | ~2,2 | ~2,0 | ~14,8 |

Percentis de componentes não somam. Todas as execuções: correctness OK,
migrations 27, schema diff 0/0. **Decisão: KEEP.** O ganho é material (commit →
detecção de ~0,9 s para ~10 ms p99), a mudança é pequena, o bus continua
best-effort (hint perdido = latência de polling, entrega igual) e o intervalo de
polling não foi alterado. Brutos: `sc-wake-{1,2}/`, `sc-drop-{1,2}/`, cada um
com `decomposition.json`.

O experimento antigo do harness `PERF_CONTROL_WAKE=1` agora aborta a réplica:
ele publicaria um segundo hint artificial por cima do de produção.

### GameCommand: experimento, sem mudança em `src/`

MULTI, 201 comandos atuais vs 496 com o experimento `PERF_COMMAND_WAKE=1` (só
harness: hint no kind `REALTIME` e `tick()` direto, sem coalescing/rerun):

| p50/p95/p99 ms | polling atual | experimento |
| --- | --- | --- |
| created → reserved | 317/332/341 | 10,9/147/201 |
| submit → Agent recebe | 328/342/354 | 22,4/154/212 |

O polling de 500 ms domina o create→dispatch atual. O ganho potencial é grande;
a cauda do experimento vem da falta de rerun (hint durante tick fica para o
polling). **Candidato 12.6B.2**, não integrado. Integrado e validado na 12.6B.2 (abaixo).

### Flakes e validação

- `flakes.mjs`, 3 normal + 3 com injeção de 1000 ms + 3 com readiness C=32
  (≈2,4k + ≈560 requisições por execução, 0 falhas): **18/18**, maior tentativa
  GameCommand = 2 (esperada), nenhuma tentativa 3. A injeção disparou 0 vezes:
  os sleeps históricos de 200/400 ms que ela atrasa não existem mais nesses
  testes. Janelas de teste intactas (ACK GameCommand 600 ms, entrega
  ServerControl 1 s).
- `npm test`: **708/708, 45 suítes**. E2e focados (game-agent,
  game-command-agent, server-control, server-control-agent, multi-instance,
  security, observability): **132/132, 7 suítes**.
- Lint, build, `tsc --noEmit --incremental false`, `git diff --check`: verdes.
  27 migrations, nenhuma nova.

## 12.6B.2 — soak, leak e tuning baseado em evidência

**MEASURED_LOCAL_BASELINE — NOT A PRODUCTION SLA.** Tabelas completas em
[performance-12.6b-measurements.md](performance-12.6b-measurements.md); brutos
em `.perf-results/12.6b2/`. Mesmo host e PostgreSQL da 12.6B.1, bancos novos
por execução, bancos residuais antigos intocados.

### Clock: 13 execuções, nenhuma falha de correctness

Os 12 casos do `clockCase` mais `db-skew` nos dois sentidos, contra o dist da
12.6B.1. 4 PASS_EXPECTED, 9 EXPECTED_TIMEOUT, 0 CORRECTNESS_FAILURE. Nenhum
efeito físico/econômico duplicado, nenhum reenvio de ServerControl, nenhum
Agent recuperando autoridade depois de fechado, ledger balanceado em todas.
Steps do relógio civil do owner antecipam ou atrasam deadlines persistidos
(retry de ACK em 515 ms com +8 s; UNCERTAIN antecipado com +7 s; sessões
fechadas como heartbeat vencido com +35 s ou como STALE pelo sweep da outra
réplica com −35 s). Skew de ±12 s do Agent muda a janela de `notAfter` que ele
enxerga; um Agent adiantado recusa a execução, sem efeito. Skew fixo de ±35 s
entre app e PostgreSQL não afetou comandos, controles, realtime, limiter ou
leases. Um skew de +35 s entre réplicas gravou `completed_at` anterior a
`created_at` numa operação correta: timestamps de auditoria entre instâncias
não são monotônicos sob skew.

**Decisão: arquitetura de clock mantida.** Durações locais usam relógio
monotônico (janela do Agent, cadência do sweep, harness). Deadlines de domínio
distribuídos continuam em relógio civil persistido. Produção exige
sincronização de relógio (NTP/chrony) entre réplicas, Agents e PostgreSQL; um
step civil altera o tempo percebido dos deadlines conforme a tabela, sem
violar at-least-once, at-most-once ou fencing. Não há evidência que justifique
migration, autoridade de tempo no PostgreSQL ou persistir relógio monotônico.

### GameCommand wake-up: KEEP

Mesmo padrão do ServerControl. `GameCommandWork` (provider pequeno em
`game-bridge`) anuncia depois do commit, a partir de `ActorCommandService.create`,
`VipDeliveryService` (comando criado) e `GameCommandBus.submit`, e só quando o
command foi criado (replay HTTP não anuncia). O anúncio acorda o worker local e
publica `GAME_COMMAND_WORK` com payload `{}`. O `GameCommandWorker` assina os
dois: ignora o hint sem sessão ACTIVE local, agenda no máximo um tick, faz no
máximo um rerun, não age depois do shutdown, e o tick relê a fila e o orçamento
em voo no banco. O polling de 500 ms continua. O sinal fica fora do
`GameCommandBus` no lado do Agent porque o teste de fronteira proíbe o código
do Agent de importar quem cria comandos.

Testes: 4 unitários (coalescing local+bus, rerun único, pico 1, sem sessão
ignora, shutdown, polling sem hint) e 1 e2e MULTI (comando criado em B, A
acorda e entrega; hint perdido cai no polling sem `wake`; wakes duplicados
durante o voo não geram tentativa; B nunca chama `dispatchEligible`; payload
`{}`; mesma identidade, tentativa 1, um resultado).

Antes/depois, created→reserved p99: MULTI 344 → 22 ms, SINGLE 337 → 18,5 ms;
created→terminal p99 MULTI 359 → 40 ms. Tentativa 1 em 100%, 0 efeitos
duplicados, B com 0 envios, sem trabalho concorrente no worker. Limitação
exposta, não criada: o limite de mensagens do Agent (200/10 s; ACK + RESULT
por comando) limita um servidor a ~9–10 GameCommands/s; lanes closed-loop
acima disso fecham o Agent com RATE_LIMITED, com ou sem wake, porque o polling
nunca reduziu frames por comando. Limite de segurança não alterado.

### Soak MULTI de 15 minutos

906 s reais de workload misto moderado (reads, refresh, GameCommand com
ACK/RESULT, ServerControl a cada 20 s, DOMAIN_EVENT e WORK_SYNC, Trade,
Marketplace, VIP, realtime Player e Staff, churn, bus e limiter distribuídos)
mais 297 s de cooldown. 0 respostas 429/5xx/erro nos lanes; reads 163 ok/s com
p99 9,7 ms; GameCommand 6,7/s com p99 73 ms. Correctness: 32 checagens
periódicas e a verificação final sem violação (6.080 comandos SUCCEEDED na
tentativa 1, 46 controles com um frame, ledger balanceado, nada aberto).

- CPU 0,24/0,20 núcleo por réplica, PostgreSQL 0,31. Event-loop máximo
  17,8 ms. Pool esperou em 1 de 895 amostras.
- Memória: heap pós-GC 52,7/51,3 → 57,2/56,2 MiB, estável entre início e fim
  do cooldown; RSS 184/186 → 275/268 (pico) → 273/266 MiB, sem retorno
  (esperado do allocator). Handles e sockets voltaram ao baseline; registry e
  leases realtime 0.
- 4 episódios simultâneos de ~0,3–0,8 s em operações não relacionadas, com a
  app ociosa de event-loop; um coincide com checkpoint do PostgreSQL. Tratados
  como ruído do host/I/O, sem gargalo da aplicação.

### Convergência, churn e crash

- Bus: pico de 1.955 linhas (983 já expiradas aguardando cleanup), 0 em 116 s
  após o fim da carga (TTL 60 s + cleanup a cada 60 s). Limiter: pico de 220
  buckets e 8 slots, 0 em 116 s e 56 s. Leases: 0 em 1 s.
- Churn dedicado: 37.450 ciclos connect/auth/evento/close em duas execuções,
  0 falhas. Após cada rodada, registry, leases em memória e no banco voltam a 0
  e os handles ficam limitados. O heap pós-GC cresce ~0,5 MiB por rodada no
  início e ~0,1–0,3 nas últimas: curva desacelerando, sem objeto realtime
  retido. Horizonte maior segue como validação de staging/produção.
- Crash (SIGKILL no owner): reconexão em B em 36 ms e primeiro comando pelo
  novo owner em 94 ms; sessão órfã STALE em 30,5 s; lease órfã expirada em
  59,5 s.

### Tuning final: nenhuma mudança de configuração

| Item | Evidência | Decisão |
| --- | --- | --- |
| `DB_POOL_MAX` | soak: waiting em 1/895 amostras; overload: CPU da réplica satura antes, PostgreSQL com folga | 10, sem controle 12 (critério não atingido) |
| Heartbeat do Agent (10 s / timeout 30 s) | pior lag 17,8 ms no soak, 52 ms no churn, stalls ≤ 0,8 s; recuperação após crash 30,5 s | mantido (margem > 35×) |
| Lease realtime (TTL 60 s / renovação 20 s) | mesma evidência; lease órfã some em 59,5 s | mantido |
| TTL e cleanup do bus (60 s / 60 s) | pico 1.955 linhas, zero em 116 s | mantido |
| Worker ServerControl / GameCommand | wake-up resolve a latência normal; polling é fallback | intervalos mantidos (1 s / 500 ms) |
| Outros workers | tick p99 ≤ 25 ms, 0 erros, backlogs 0 | mantidos |
| Índices / migration | nenhuma query surgiu como gargalo | 27 migrations, sem EXPLAIN adicional |

### Overload curto

60 s por degrau, todos os subsistemas juntos, reads C=32 e C=128. Reads
achatam em ~1,2k → 1,7k ok/s com p99 53 → 138 ms. GameCommand degrada para
p50 1,2 → 2,4 s, sem timeout e sem nova tentativa. Login Staff e chat recebem
429 conforme as proteções. 0 respostas 5xx ou de transporte, sem OOM
(RSS ≤ 509 MiB), sem deadlock (lock waiters ≤ 4), backlog drenado logo após a
carga, 0 duplicatas, ledger balanceado. **Primeiro limitante: CPU por réplica**
(~1,4 núcleo, thread JS saturada) com a fila do pool como sintoma; PostgreSQL
em 1,7 de 16 núcleos.

### Validação 12.6B.2

- `npm test`: 712/712, 45 suítes. Lint, build, `tsc --noEmit --incremental
  false` e `git diff --check`: verdes. 27 migrations, nenhuma nova.
- E2e focados com o código final, antes do soak (game-command-agent, game-agent,
  server-control-agent, server-control, multi-instance, security,
  observability): 133/133.
- Flakes: 3 rodadas completas de game-command-agent, server-control-agent e
  multi-instance, 56/56 cada (168/168). As sincronizações continuam por
  barreira/estado; as pausas restantes verificam ausência ou posicionam
  deadlines intencionais.
- Full e2e, release checklist, Agent/SKSE real, PgBouncer, proxy e rolling
  deploy ficam para 12.6C/12.7.

## 12.6C — validação final

Sem novo tuning nem load pesado; código de produção da 12.6B inalterado.

- Lint, build, `tsc --noEmit --incremental false`, `git diff --check`: verdes.
- `npm test`: 712/712, 45 suítes.
- E2e completo (`TEST_DATABASE_INTEGRATION=true npm run test:e2e`, banco
  descartável só com as coordenadas do banco): **40/40 suítes, 864/864, 0
  skips**. Uma primeira tentativa carregou o `.env.example` inteiro, que fixa
  `OPERATIONS_ACTION_RATE_LIMIT_PER_MINUTE=30` e anula o default generoso de
  `test/setup-env.ts`: `operational-recovery` recebeu 429. Erro do ambiente da
  execução, não do código; refeita no fluxo pretendido.
- Conjunto crítico (game-command-agent, server-control-agent, multi-instance,
  game-agent, security, observability, operational-recovery,
  deployment-extensions/lifecycle/readiness), 3 rodadas em bancos novos:
  **3 × 125/125**, sem flake.
- Banco novo pelo runner compilado de produção (`node dist/database/migrate.js`):
  27 aplicadas, `pending=false`, `synchronize=false`, diff 0/0. Upgrade
  26 → 27 coberto por `test/multi-instance.e2e-spec.ts` no e2e completo; a
  migration 27 não mudou desde a 12.5 (`0523e16`).
- `npm run perf:smoke` (MULTI, reads + commands + control): correctness OK,
  hints `GAME_COMMAND_WORK` 11/11 e `SERVER_CONTROL_WORK` 15/15 publicados e
  recebidos, schema 27/diff 0/0; brutos só em `.perf-results/` (ignorado).
- `npm audit`: os 2 HIGH históricos (multer via `@nestjs/platform-express`);
  nenhum uso de multipart/`FileInterceptor` em `src/`, não alcançável pelo
  runtime atual. Sem `audit fix`; upgrade do Nest isolado para 12.7/manutenção.
