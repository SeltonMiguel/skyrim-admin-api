# 12.6B — medições agregadas

**MEASURED_LOCAL_BASELINE — NOT A PRODUCTION SLA.**

Host local compartilhado (WSL2, Intel Core 7 240H, 16 CPUs, 15,4 GiB),
PostgreSQL 16 em container (loopback 5434), Node 24.18.0, base `8b291c8` com o
working tree de 27/09/2026. Réplicas e gerador na mesma máquina. Durações por
`process.hrtime` do host; timestamps persistidos continuam civis. Pool
`DB_POOL_MAX=10` por réplica em todas as execuções. Cada execução usa um banco
novo `skyrim_perf_<hex>`, removido no fim; os bancos residuais anteriores não
foram tocados. Brutos em `.perf-results/12.6b2/` (ignorado pelo Git).
Latências em ms.

## 1. Clock step/skew (13 execuções, MULTI, dist da 12.6B.1)

Injeção só no processo (`PERF_CLOCK_CONTROL`: `Date`/`new Date()` da réplica
ou do FakeAgent); hrtime, timers e `NOW()` do PostgreSQL intactos. Os 12 casos
do `clockCase` mais `db-skew` nos dois sentidos. Em todas: resultados e receipts
duplicados = 0, efeitos duplicados no journal do Agent = 0, ServerControl com
mais de um frame = 0, ledger balanceado, 27 migrations, schema diff 0/0.

| # | Caso | Injeção | Observado | Classe |
| --- | --- | --- | --- | --- |
| 1 | baseline | nenhuma | 4 comandos e 2 controles SUCCEEDED, tentativa 1 | PASS_EXPECTED |
| 2 | retry-reference | Agent sem ACK em tempo | 3 tentativas a ~5,5 s, 1 efeito, mesma identidade | PASS_EXPECTED |
| 3 | small-step | A e B +1,2 s por 3 s | 8 comandos e 2 controles SUCCEEDED, tentativa 1 | PASS_EXPECTED |
| 4 | forward-owner | owner A +8 s com ACK pendente | retry antecipado (515 ms em vez de 5 s), tentativa 2, 1 efeito; `notAfter` visto pelo Agent com 18 s | EXPECTED_TIMEOUT |
| 5 | forward-owner-result | A +7 s, result timeout 5 s, Agent executando | UNCERTAIN/RESULT_TIMEOUT antecipado; efeito 1 vez; RESULT tardio recusado (RESULT_CONFLICT), sem reabrir nem reenviar | EXPECTED_TIMEOUT |
| 6 | forward-owner-large | A +35 s (> timeout de heartbeat 30 s) | A fecha os 2 Agents (4008) em 850 ms; comando novo fica PENDING com 0 tentativas | EXPECTED_TIMEOUT |
| 7 | backward-owner | A −8 s com ACK pendente | retry atrasado (12,5 s em vez de 5 s), tentativa 2, 1 efeito | EXPECTED_TIMEOUT |
| 8 | backward-owner-large | A −35 s | sweep de B vê heartbeats de A como velhos: sessões STALE, Agents fechados (4011) em ~20 s; nenhum recupera autoridade | EXPECTED_TIMEOUT |
| 9 | backward-rate-window | A −35 s com 12 frames/s legítimos | sem RATE_LIMITED; fechado por SESSION_CLOSED (mesmo STALE falso do caso 8) | EXPECTED_TIMEOUT |
| 10 | skew-http-replica | B −35 s, depois B +35 s | B atrás: controles FAILED/DISPATCH_EXPIRED sem claim nem efeito; B à frente: SUCCEEDED, mas `completed_at` 35 s **antes** de `created_at` | EXPECTED_TIMEOUT (timestamps fora de ordem) |
| 11 | agent-skew | Agent +12 s / −12 s | Agent adiantado recusa a execução (FAILED/DELIVERY_EXPIRED, 0 efeitos); atrasado executa com janela aparente de 22 s | EXPECTED_TIMEOUT |
| 12 | db-skew-ahead | app +35 s vs `NOW()` desde o boot | 6 comandos e 2 controles SUCCEEDED; realtime entregue; limiter admitiu exatamente 10 de 100; TTL da lease 59,9 s | PASS_EXPECTED |
| 13 | db-skew-behind | app −35 s vs `NOW()` desde o boot | idem | PASS_EXPECTED |

`CORRECTNESS_FAILURE`: 0. Na primeira passada, três execuções abortaram por
defeito do harness, não do produto: `forward-owner-result` com result timeout
menor que a delivery window (a validação de config recusa); `db-skew` com PATCH
de settings para o locale default (nada muda, nenhum evento é publicado).
Corrigidas e reexecutadas; as primeiras tentativas estão em
`clock/failed-first-attempt/`.

## 2. GameCommand wake-up: antes/depois

2 lanes closed-loop (`PERF_COMMAND_STEPS=1,2`, um lane por servidor), 30 s
por degrau, Agents em A. "Hint suprimido" = `PERF_COMMAND_HINT_DROP=1`
(anúncio de produção vira no-op; equivalente ao comportamento sem wake-up).

| p50/p95/p99 | MULTI hint suprimido (n=182) | MULTI wake (n=476 / final n=490) | SINGLE hint suprimido (n=183) | SINGLE wake (n=484) |
| --- | --- | --- | --- | --- |
| created → reserved | 316/332/344 | 9,1/16,6/22,1 · 9,0/13,3/23,2 | 316/331/337 | 8,0/14,9/18,5 |
| created → frame enviado | 316/332/344 | 9,2/16,7/22,1 · 9,0/13,4/23,3 | 316/331/337 | 8,0/14,9/18,6 |
| created → terminal | 328/345/359 | 19,4/27,2/40,1 · 19,2/25,9/41,9 | 328/342/350 | 18,2/26,0/30,6 |
| comandos concluídos/s (C=2) | 4,0 | 10,6 · 10,9 | 4,0 | 10,7 |

Todas: tentativa 1 em 100%, 0 efeitos duplicados, correctness OK. MULTI: B fez
0 envios; ticks do GameCommandWorker sem trabalho concorrente (10–14 chamadas
pulando o guard `running` por execução, < 0,5 ms, sem trabalho).

Primeira tentativa com o cenário padrão (degraus 1/4/8): no degrau C=4 com
wake, cada Agent passou de 20 frames/s (limite de segurança de 200 mensagens
por 10 s; cada comando gera COMMAND_ACK + COMMAND_RESULT) e foi fechado com
`4012 RATE_LIMITED`. O polling não reduz frames por comando: ele só estrangulava
o closed-loop do harness. **MEASURED_LOCAL_CAPACITY_CONSTRAINT:** o limite de
mensagens do Agent é o teto de GameCommands por servidor (~9–10/s descontando
heartbeats), com ou sem wake. Não é SLA nem bug; limite não alterado; a 12.7
valida o workload real do Agent/SKSE contra ele. Evidência em `gc-rate-limited-first-attempt/`.

## 3. Soak MULTI

900 s de workload pedidos, **906,3 s reais** (monotônico), 2 réplicas, 4 lanes
de leitura com pacing de 20 ms, cooldown de 297 s com apps e banco vivos.

| Tipo | Concluídos | ok/s | 429 | 5xx/erro | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HTTP reads (5 rotas) | 147.126 | 163,5 | 0 | 0 | 3,9 | 7,8 | 9,7 | 49,8 |
| GameCommand (HTTP em B → RESULT) | 6.004 | 6,67 | 0 | 0 | 44,7 | 55,6 | 73,0 | 789,6 |
| ServerControl | 46 | 0,05 | 0 | 0 | 28,2 | 123,1 | 382,6 | 382,6 |
| Trade / Marketplace / VIP grant | 76 / 76 / 76 | 0,08 cada | 0 | 0 | 47,8 / 33,5 / 5,8 | 76,9 / 47,7 / 8,4 | 412 / 54,7 / 13,0 | — |
| WORK_SYNC | 902 | 1,0 | 0 | 0 | 3,7 | 9,6 | 15,2 | 309 |
| Player settings (→ realtime) | 902 | 1,0 | 0 | 0 | 4,8 | 12,0 | 19,3 | 363 |
| Chat global | 362 | 0,4 | 0 | 0 | 9,0 | 18,4 | 46,3 | 362 |
| Refresh Staff/Player | 36 | 0,04 | 0 | 0 | 4,8 | 12,9 | 362 | 362 |
| Realtime churn (connect+auth+close) | 182 | 0,2 | 0 | 0 | 5,7 | 12,0 | 81,4 | 362 |
| Limiter distribuído | 4.507 | 5,0 | 0 | 0 | 1,8 | 3,7 | 5,2 | 541 |
| Staff fanout (publish) | 902 | 1,0 | 0 | 0 | 0,3 | 0,8 | 1,2 | 3,5 |

Eventos realtime: 902 Player, 6.952 Staff; 4 reaberturas planejadas dos
sockets longos após refresh; 0 erros de lane. Por janela de 10 s: reads
157–169 ok/s, p99 7,3–12,9 ms. GameCommand dentro do soak (amostra do timeline,
truncado pelo buffer de 20 mil eventos: n=2.672): created→reserved
10,5/22,1/32,6; created→terminal (journal, n=6.004) 20,6/32,3/43,5.
ServerControl commit→owner (n=21) 3,6/10,4/11,8.

Os máximos de ~0,3–0,8 s aparecem **ao mesmo tempo** em operações não
relacionadas em 4 das 90 janelas (≈270–320 s, 770 s, 890 s). O event-loop das
réplicas ficou ≤ 17,8 ms e o pool esperou em 1 de 895 amostras. O episódio de
~300 s coincide com o início de um checkpoint do PostgreSQL (16:00:19 UTC); os
outros não foram atribuídos (host WSL/I/O). Não indicam gargalo da aplicação.

| Recurso (A / B) | antes | pico | fim do workload | fim do cooldown |
| --- | --- | --- | --- | --- |
| RSS MiB | 183,6 / 186,0 | 274,9 / 268,3 | 274,9 / 268,3 | 272,5 / 266,2 |
| Heap usado MiB (amostra) | 52,7 / 51,4 | 117,7 / 116,0 | 79,4 / 84,2 | 60,5 / 57,6 |
| Heap pós-GC forçado MiB | 52,7 / 51,3 | — | 58,0 / 56,2 (início do cooldown) | 57,2 / 56,2 |
| Handles ativos | 22 / 10 | 34 / 35 | — | 12 / 10 |
| TCP sockets | 15 / 4 | 22 / 23 | — | 5 / 4 |
| Registry/leases/tokens realtime (pós-GC) | 0 | — | 0 | 0 |

| Réplica | CPU (núcleos) | lag p99 mediano | lag p99 máx | lag máx | pool waiting máx (amostras > 0) | ticks pulados |
| --- | --- | --- | --- | --- | --- | --- |
| A (Agents) | 0,24 | 10,9 | 13,3 | 17,3 | 1 (1/895) | game_command 146, demais 0 |
| B | 0,20 | 10,9 | 13,3 | 17,8 | 0 | 0 |

PostgreSQL: 0,31 núcleo, memória do container 257 → 346 (pico) → 290 MiB;
conexões do banco 9 → 18 (pico) → 8. Lag do event-loop tem resolução de 10 ms
(`monitorEventLoopDelay`): ~11 ms é o piso da medição. Worker tick p99 (limite
superior do bucket): game_command 50 (A) / 5 (B), server_control 10,
vip_delivery 25, agent_work_push 25, heartbeat_sweep 5, backlog_collector 10.
Tick errors = 0. `recovery_unresolved` máx = 0.

| Tabela | antes | pico | fim do workload | fim do cooldown | zero após o fim |
| --- | --- | --- | --- | --- | --- |
| distributed_bus_events | 18 | 1.955 (983 expiradas) | 1.000 | 0 | 116 s |
| rate_limit_buckets | 11 | 220 (166 expirados) | 74 | 0 | 116 s |
| rate_limit_slots | 0 | 8 | 6 | 0 | 56 s |
| realtime_connection_leases | 0 | 3 | 0 | 0 | 1 s |
| backlogs (commands, controls, trades, purchases, custody, releases, VIP) | 0 | ≤ 2 | 0 | 0 | — |
| lock waiters | 0 | 1 | 0 | 0 | — |

Invariantes a cada 30 s (32 checagens: resultados/receipts duplicados, ledger,
comando VIP compartilhado, duas sessões CONNECTED no mesmo servidor): 0
violações. Verificação final: 6.080 comandos (6.004 HTTP + 76 VIP) todos
SUCCEEDED na tentativa 1, 46 controles SUCCEEDED com 1 frame cada, 0 efeitos
duplicados, ledger balanceado, nenhum Trade/Marketplace/VIP aberto, sessões e
leases 0 após o encerramento, schema diff 0/0.

## 4. Realtime churn dedicado (MULTI)

4 lanes, cada ciclo connect → AUTH Player → evento publicado pela outra réplica
→ recebido → close, pacing de 50 ms (abaixo do limite de 60 conexões/min por IP
com 96 IPs). GC forçado nos snapshots.

| Execução | Ciclos | Falhas | connect+auth p50/p95/p99 |
| --- | --- | --- | --- |
| 5 rodadas × 40 s, 50 s ocioso | 12.472 | 0 | 10,6/15,3/19,1 |
| 10 rodadas × 40 s, 15 s ocioso | 24.978 | 0 | — |

Heap pós-GC por rodada, 10 rodadas (MiB, A / B): antes 52,8 / 51,4; r1 51,8 /
50,6; r4 53,6 / 51,9; r7 54,8 / 53,3; r8 54,9 / 53,4; r9 55,0 / 53,4; r10
55,3 / 53,6. Após cada rodada: registry 0, leases em memória 0, leases no banco
0, handles 16–18 (A) e 14–16 (B), sem tendência. O heap cresce ~0,5 MiB por
rodada nas primeiras 7 e ~0,1–0,3 nas últimas 3: curva desacelerando
(aquecimento), sem objeto realtime retido. Não é prova de ausência de leak em
horizonte maior; ver pendências da 12.6C.

## 5. Crash do owner (SIGKILL em A)

| Evento | ms após o kill |
| --- | --- |
| Agents veem o close | 20 |
| Agent do servidor 0 reconectado em B | 36 |
| Primeiro GameCommand pelo novo owner concluído | 94 |
| Sessão órfã do servidor 1 marcada STALE por B | 30.525 |
| Lease realtime órfã expirada | 59.500 |

Safety OK (0 duplicatas, ledger balanceado).

## 6. Overload curto (MULTI, 60 s, todos os subsistemas juntos)

| Stage | C=32: ok/s · p50/p95/p99 | C=128: ok/s · p50/p95/p99 | 429 / 409 (C=32 · C=128) |
| --- | --- | --- | --- |
| Reads | 1.244,8 · 24,4/34,6/53,3 | 1.681,8 · 77,9/111,4/137,9 | 0 · 0 |
| GameCommand (16 lanes) | 12,8 · 1.244/1.431/1.996 | 6,4 · 2.428/3.456/3.539 | 0 · 0 |
| ServerControl (4 lanes) | 11,3 · 161/296/371 | 4,8 · 413/655/799 | 409: 859 · 682 |
| Staff login (8 lanes) | 4,0 · 220/253/422 | 4,0 · 340/388/493 | 429: 42.230 · 13.650 |
| Chat (8 lanes) | 4,7 · 63/167/300 | 4,3 · 137/238/412 | 429: 12.963 · 4.607 |

| Recurso | C=32 | C=128 |
| --- | --- | --- |
| CPU por réplica (A / B) | 1,39 / 1,39 | 1,39 / 1,40 |
| CPU PostgreSQL (de 16) | 1,76 | 1,72 |
| Pool waiting máx (amostras com espera) | 23 / 18 (100%) | 79 / 79 (100%) |
| Lag do event-loop máx | 21,4 | 33,5 |
| RSS pico MiB | 509 / 471 | 483 / 460 |
| Conexões do banco / lock waiters máx | 24 / 4 | 24 / 1 |

0 respostas 5xx ou de transporte; Agents não fechados; backlog drenado logo após
a carga (commands SUCCEEDED na tentativa 1: 768 · 387; controls SUCCEEDED:
679 · 288); 0 duplicatas; ledger balanceado; nada aberto; schema diff 0/0.
Primeiro limitante: CPU por réplica (thread JS), com a fila do pool como
sintoma; PostgreSQL com folga.

## 7. Regressões

`npm test`: 712/712 (45 suítes). E2e focados antes do soak (game-command-agent,
game-agent, server-control-agent, server-control, multi-instance, security,
observability): 133/133. Flakes: 3 rodadas completas de game-command-agent,
server-control-agent e multi-instance, 56/56 cada.
