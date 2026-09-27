import { monotonicMs } from './clock.mjs';
// Run from the repository root after npm run build. No global load tool.
import 'reflect-metadata';
import { fork, execFileSync } from 'node:child_process';
import { mkdir, writeFile, appendFile, readFile, open } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { DataSource } from 'typeorm';
import { Http, Agent, Socket, pause, until } from './client.mjs';
import { scenarios } from './scenarios.mjs';

const profiles = { smoke: { duration: 2, concurrency: 1 }, baseline: { duration: 10, concurrency: 4 },
  load: { duration: 10, concurrency: 16 }, saturation: { duration: 10, concurrency: 128 },
  soak: { duration: 600, concurrency: 4 } };
const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
  if (!/^--[a-z-]+=.+$/.test(arg)) throw new Error('Flags use --name=value');
  const index = arg.indexOf('='); return [arg.slice(2, index), arg.slice(index + 1)];
}));
const profile = flags.profile ?? process.env.PERF_PROFILE ?? 'smoke';
if (!profiles[profile]) throw new Error('Unknown profile');
const number = (name, fallback, min, max) => {
  const n = Number(flags[name] ?? process.env[`PERF_${name.toUpperCase().replaceAll('-', '_')}`] ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)) throw new Error(`Invalid ${name}`); return n;
};
const opts = { endpoints:flags.endpoints?.split(','), profile, duration: number('duration', profiles[profile].duration, 1, 1800),
  concurrency: number('concurrency', profiles[profile].concurrency, 1, 256), replicas: number('replicas', profile === 'soak' ? 2 : 1, 1, 2),
  pool: number('pool', 10, 2, 30), seed: number('seed', 126, 1, 1000000),
  latency: number('latency', 0, 0, 2000), cooldown: number('cooldown', profile === 'soak' ? 125 : 2, 0, 300),
  scenario: flags.scenario ?? process.env.PERF_SCENARIO ?? (profile === 'soak' ? 'mixed' : 'reads') };
if (profile === 'soak' && (opts.duration < 600 || opts.replicas !== 2)) throw new Error('Soak requires MULTI and >=600 real seconds');
for (const s of opts.scenario.split(',')) if (!scenarios[s]) throw new Error(`Unknown scenario ${s}`);
const host = process.env.PERF_DB_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Performance database must be local');
// Never read DB_DATABASE or .env. CREATE must succeed; no existing DB is reset.
const dbName = `skyrim_perf_${randomBytes(8).toString('hex')}`;
const adminConfig = { host, port: Number(process.env.PERF_DB_PORT ?? 5434), user: process.env.PERF_DB_USERNAME ?? 'skyrim',
  password: process.env.PERF_DB_PASSWORD ?? 'skyrim', database: 'postgres', connectionTimeoutMillis: 5000 };
const root = path.resolve(flags.output ?? process.env.PERF_OUTPUT ?? `/tmp/skyrim-perf-${Date.now()}-${profile}`);
if (root===process.cwd() || root.startsWith(`${process.cwd()}/`) && !root.startsWith(`${process.cwd()}/.perf-results/`)) throw new Error('Raw results must be outside Git or in .perf-results/');
await mkdir(root, { recursive: true });
const marker=await open(`${root}/run.lock`,'wx');await marker.close();
console.log(JSON.stringify({ output: root, ...opts }));
const admin = new pg.Client(adminConfig); admin.on('error', e=>console.error('Perf admin:',e.message)); let created = false, db, dataSource;
const children = [], agents = [], sockets = [], stages = [], samples = [];
let pgCgroup;
try { const pid=execFileSync('docker',['inspect','--format','{{.State.Pid}}',process.env.PERF_PG_CONTAINER??'skyrim-admin-api-postgres-1'],{encoding:'utf8'}).trim();
  const group=(await readFile(`/proc/${pid}/cgroup`,'utf8')).trim().split('::')[1]; pgCgroup=`/sys/fs/cgroup${group}`; } catch { /* Optional Linux container metrics, explicitly null elsewhere. */ }
let interrupted=false;
let http, stopped = false, sampleTask, nextId = 0, keyId = 0;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{interrupted=true;stopped=true;});
const password = randomBytes(24).toString('base64url');
const key = () => `perf:${opts.seed}:${++keyId}`;
const deterministicId = value => {
  const h = createHash('sha256').update(`${opts.seed}:${value}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
function spawn(env, index) {
  const child = fork(new URL('./replica.mjs', import.meta.url), [], { env, silent: true, execArgv: process.env.PERF_EXPOSE_GC === '1' ? ['--expose-gc'] : [] });
  const pending = new Map();
  const log = chunk => { void appendFile(`${root}/replica-${index}.log`, chunk); };
  child.stdout.on('data', log); child.stderr.on('data', log);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Replica boot timeout')), 60000);
    child.on('message', msg => { if (msg.ready) { clearTimeout(timer); resolve(msg); }
      else { const p = pending.get(msg.id); if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.value); } } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Replica exit ${code}; inspect replica-${index}.log`));
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Replica exit ${code}`)); } pending.clear(); });
  });
  const rpc = (op, args) => new Promise((resolve, reject) => {
    const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timeout ${op}`)); }, 60000);
    pending.set(id, { resolve, reject, timer }); child.send({ id, op, args });
  });
  const result = { child, ready, rpc }; children.push(result); return result;
}
function histogram(values) {
  values.sort((a,b) => a-b); const quantile = q => values[Math.max(0, Math.ceil(values.length*q)-1)] ?? 0;
  return { count: values.length, p50: quantile(.5), p95: quantile(.95), p99: quantile(.99), max: values.at(-1) ?? 0 };
}
async function stage(name, action, concurrency = opts.concurrency, duration = opts.duration, paceMs = 0) {
  const resourceBefore=await Promise.all(alive().map(c=>c.rpc('state')));
  const startedAt = new Date().toISOString(), start = monotonicMs(), end = start + duration*1000;
  const latencies = [], successLatencies = [], statuses = {}, failures = [];
  let count = 0, success = 0;
  const firstSample = samples.length;
  await Promise.all(Array.from({ length: concurrency }, async (_, lane) => {
    while (monotonicMs() < end && !stopped) {
      const t = monotonicMs();
      try { const r = await action(lane, count++); const status = r?.status ?? 200;
        statuses[status] = (statuses[status] ?? 0) + 1;
        if (status >= 200 && status < 300) { success++; successLatencies.push(monotonicMs()-t); }
      } catch (error) { statuses.transport = (statuses.transport ?? 0)+1; if (failures.length < 5) failures.push(error.message); }
      latencies.push(monotonicMs()-t);
      if (paceMs) await pause(paceMs);
      if (latencies.length >= 1000000) { stopped = true; throw new Error('Harness sample bound reached'); }
    }
  }));
  const elapsed = (monotonicMs()-start)/1000;
  const resourceAfter=await Promise.all(alive().map(c=>c.rpc('state')));
  const expected4xx = Object.entries(statuses).filter(([s])=>Number(s)>=400&&Number(s)<500).reduce((n,[,v])=>n+v,0);
  const errors = Object.entries(statuses).filter(([s])=>s==='transport'||Number(s)>=500).reduce((n,[,v])=>n+v,0);
  const resource = samples.slice(firstSample);
  const result = { name, startedAt, startedMono:start, endedMono:monotonicMs(), civilClockDeltaMs:Date.now()-Date.parse(startedAt), resourceBefore,resourceAfter, appCpuCores:resourceAfter.reduce((n,r,i)=>n+(r.cpu.user+r.cpu.system-resourceBefore[i].cpu.user-resourceBefore[i].cpu.system)/1e6/elapsed,0), seconds: elapsed, concurrency, count, throughput: count/elapsed,
    usefulThroughput: success/elapsed, latencyMs: histogram(latencies), successLatencyMs: histogram(successLatencies),
    statuses, expected4xx, errors, errorRate: errors/Math.max(1,count), failures,
    samples: resource.length, maxRss: Math.max(0,...resource.flatMap(s=>s.nodes.map(n=>n.memory.rss))),
    maxPoolWaiting: Math.max(0,...resource.flatMap(s=>s.metrics.map(m=>metric(m,'db_pool_connections{state="waiting"}')))),
    maxEventLoopLag: Math.max(0,...resource.flatMap(s=>s.metrics.map(m=>metric(m,'nodejs_eventloop_lag_p99_seconds')))),
    maxEventLoopStall:Math.max(0,...resource.flatMap(s=>s.metrics.map(m=>metric(m,'nodejs_eventloop_lag_max_seconds')))),
    db: resource.at(-1)?.tables };
  stages.push(result); await writeFile(`${root}/stages.json`, JSON.stringify(stages,null,2));
  console.log(JSON.stringify(result)); return result;
}
function metric(text, suffix) {
  const line = text.split('\n').find(l=>l.startsWith(`skyrim_admin_${suffix} `)); return line ? Number(line.split(' ').at(-1)) : 0;
}
// A replica killed on purpose (crash scenario) is excluded from sampling.
const alive = () => children.filter(c=>c.child.exitCode===null&&c.child.signalCode===null);
// Forced-GC heap snapshots before the workload and around the cooldown
// (PERF_EXPOSE_GC=1 only; the app never calls gc itself).
const gcSnapshot = async label => process.env.PERF_EXPOSE_GC==='1' ? { label, mono:monotonicMs(), nodes: await Promise.all(alive().map(c=>c.rpc('gc'))),
  state: await Promise.all(alive().map(c=>c.rpc('state'))), realtime: await Promise.all(alive().map(c=>c.rpc('realtime'))) } : null;
async function sample(phase) {
  const nodes = await Promise.all(alive().map(c=>c.rpc('state')));
  const metrics = await Promise.all(alive().map(c=>http.call('metrics', { token: env.METRICS_BEARER_TOKEN, node:children.indexOf(c) }).then(r=>r.body)));
  const [tables] = await query(`SELECT (SELECT count(*)::int FROM distributed_bus_events) AS bus,
    (SELECT count(*)::int FROM rate_limit_buckets) AS buckets,
    (SELECT count(*)::int FROM realtime_connection_leases) AS leases,
    (SELECT count(*)::int FROM game_connections WHERE status='CONNECTED') AS agents,
    (SELECT count(*)::int FROM game_commands WHERE status IN ('PENDING','DISPATCHED','ACKNOWLEDGED')) AS commands,
    (SELECT coalesce(max(n),0)::int FROM (SELECT count(*) n FROM game_commands WHERE status IN ('DISPATCHED','ACKNOWLEDGED') OR (status='PENDING' AND dispatch_lease_id IS NOT NULL) GROUP BY game_server_id) x) AS inflight,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS connections,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,
    (SELECT count(*)::int FROM distributed_bus_events WHERE expires_at<=now()) AS bus_expired,
    (SELECT count(*)::int FROM rate_limit_buckets WHERE expires_at<=now()) AS buckets_expired,
    (SELECT count(*)::int FROM rate_limit_slots) AS slots,
    (SELECT count(*)::int FROM rate_limit_slots WHERE expires_at<=now()) AS slots_expired,
    (SELECT count(*)::int FROM realtime_connection_leases WHERE expires_at<=now()) AS leases_expired,
    (SELECT count(*)::int FROM server_control_operations WHERE status IN ('PENDING','DISPATCHED')) AS control_open,
    (SELECT count(*)::int FROM server_control_operations WHERE status='UNCERTAIN') AS control_uncertain,
    (SELECT count(*)::int FROM player_trades WHERE status='AWAITING_GAME_CONFIRMATION') AS trades_open,
    (SELECT count(*)::int FROM player_marketplace_purchases WHERE status='AWAITING_GAME_CONFIRMATION') AS purchases_open,
    (SELECT count(*)::int FROM player_marketplace_listings WHERE status='PENDING_CUSTODY') AS custody_open,
    (SELECT count(*)::int FROM player_marketplace_item_releases WHERE status<>'COMPLETED') AS releases_open,
    (SELECT count(*)::int FROM vip_reward_deliveries WHERE status NOT IN ('SUCCEEDED','CANCELLED')) AS vip_open,
    (SELECT count(*)::int FROM game_commands) AS commands_total,
    (SELECT count(*)::int FROM pg_stat_activity) AS pg_connections_all`);
  let postgresResource=null;
  if(pgCgroup) { const cpu=await readFile(`${pgCgroup}/cpu.stat`,'utf8'); postgresResource={cpuUsec:Number(/usage_usec (\d+)/.exec(cpu)?.[1]),memoryBytes:Number(await readFile(`${pgCgroup}/memory.current`,'utf8'))}; }
  // 12.6B: safety invariants every 30 samples during long runs (cheap on the soak dataset).
  const invariants = samples.length % 30 === 0 ? (await query(`SELECT
    (SELECT count(*)::int FROM (SELECT game_command_id FROM game_command_results GROUP BY 1 HAVING count(*)>1) x) AS duplicate_results,
    (SELECT count(*)::int FROM (SELECT game_server_id,event_id FROM agent_domain_event_receipts GROUP BY 1,2 HAVING count(*)>1) x) AS duplicate_receipts,
    (SELECT count(*)::int FROM (SELECT transaction_id FROM economy_entries GROUP BY 1 HAVING sum(amount)<>0 OR count(*)<2) x) AS unbalanced,
    (SELECT count(*)::int FROM (SELECT game_command_id FROM vip_reward_deliveries WHERE game_command_id IS NOT NULL GROUP BY 1 HAVING count(*)>1) x) AS vip_shared_commands,
    (SELECT count(*)::int FROM (SELECT game_server_id FROM game_connections WHERE status='CONNECTED' GROUP BY 1 HAVING count(*)>1) x) AS servers_with_two_sessions`))[0] : undefined;
  const row = { mono:monotonicMs(), postgresResource, generator:{memory:process.memoryUsage(),cpu:process.cpuUsage()}, at: new Date().toISOString(), phase, machine: { load: os.loadavg(), free: os.freemem() }, nodes, metrics, tables, invariants };
  samples.push(row); await appendFile(`${root}/samples.jsonl`, JSON.stringify(row)+'\n');
  if (tables.inflight > 32 || nodes.some(n=>n.memory.rss > 1.5*1024**3) || os.freemem()<256*1024**2) {
    stopped = true; throw new Error('Safety stop: inflight or memory pressure');
  }
}
const env = { ...process.env, NODE_ENV:'production', PERF_CHILD:'1', DB_HOST:host, DB_PORT:String(adminConfig.port),
  DB_USERNAME:adminConfig.user, DB_PASSWORD:adminConfig.password, DB_DATABASE:dbName, DB_SSL_MODE:'disable',
  DB_POOL_MAX:String(opts.pool), DB_LOGGING:'false', BACKEND_TOPOLOGY:opts.replicas===2?'MULTI':'SINGLE',
  SINGLE_INSTANCE_LOCK_ENABLED:opts.replicas===2?'false':'true', LOG_FORMAT:'json', LOG_LEVEL:'warn',
  METRICS_ENABLED:'true', METRICS_BEARER_TOKEN:randomBytes(32).toString('hex'),
  JWT_ACCESS_SECRET:randomBytes(32).toString('hex'), JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
  PLAYER_JWT_ACCESS_SECRET:randomBytes(32).toString('hex'), PLAYER_JWT_REFRESH_SECRET:randomBytes(32).toString('hex'),
  DISCORD_CLIENT_ID:'perf', DISCORD_CLIENT_SECRET:randomBytes(32).toString('hex'), DISCORD_REDIRECT_URIS:'http://127.0.0.1/cb',
  CLUSTER_BUS_CHANNEL:`perf_${dbName.slice(-16)}` };
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${dbName}"`); created = true;
  Object.assign(process.env, env);
  const { loadEnvironment } = await import('../../dist/config/environment.js');
  const { createMigrationOptions } = await import('../../dist/database/database.options.js');
  dataSource = new DataSource(createMigrationOptions(loadEnvironment())); await dataSource.initialize();
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'); await dataSource.runMigrations();
  db = new pg.Pool({ ...adminConfig, database:dbName, max:3, application_name:'perf-observer' });
  db.on('error',e=>{console.error('Perf observer:',e.message);stopped=true;});
  const { PasswordService } = await import('../../dist/auth/password.service.js');
  const hash = await new PasswordService().hash(password);
  for (let i=0;i<8;i++) await query("INSERT INTO staff_users(id,username,display_name,password_hash,role_name) VALUES ($1,$2,$2,$3,'COORDINATOR')",
    [deterministicId(`staff:${i}`),`perf${i}`,hash]);
  const version = (await query('SELECT version()'))[0].version;
  const git = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const meta = { base:git, node:process.version, postgres:version, cpu:os.cpus()[0]?.model,
    os:{type:os.type(),release:os.release(),platform:os.platform(),arch:os.arch()}, cpuAvailable:os.availableParallelism(), logicalCpu:os.cpus().length, memory:os.totalmem(), options:opts,
    database:dbName, topology:env.BACKEND_TOPOLOGY, hardware:'shared local host; no horizontal hardware scaling', instrumentation:{sqlProfile:process.env.PERF_SQL_PROFILE==='1',poolSamplingMs:20},
    startedAt:new Date().toISOString(), cgroup:await readFile('/proc/self/cgroup','utf8').catch(()=>null) };
  const replicas = [];
  for (let i=0;i<opts.replicas;i++) replicas.push(await spawn(env,i).ready);
  meta.replicas = replicas; await writeFile(`${root}/environment.json`,JSON.stringify(meta,null,2));
  http = new Http(replicas.map(r=>r.port));
  for(let i=0;i<opts.replicas;i++) await http.ok('ready',{node:i});
  const staff = await http.ok('auth/login',{method:'POST',body:{username:'perf0',password}});
  const players = [];
  for(let i=0;i<8;i++) players.push(await http.ok('player/auth/discord/exchange',{method:'POST',identity:100+i,
    body:{authorizationCode:`perf-${opts.seed*100+i}`,redirectUri:'http://127.0.0.1/cb'}}));
  const servers = [], credentials = [];
  for(let i=0;i<2;i++) {
    const server = await children[opts.replicas-1].rpc('server',{code:`perf-${opts.seed}-${i}`,name:`Performance ${i}`}); servers.push(server);
    const credential = await http.ok(`admin/game-servers/${server.id}/agent-credentials`,{method:'POST',token:staff.accessToken},201);
    const agent = new Agent(replicas[0].port,server.id,200+i,opts.latency); agents.push(agent); await agent.hello(credential); credentials.push(credential);
  }
  const parties = [];
  for(let i=0;i<players.length;i++) {
    const character = `perf:character:${i}`;
    const link = await children[opts.replicas-1].rpc('link',{playerId:players[i].player.id,serverId:servers[0].id,character});
    parties.push({ session:players[i],link:link.id,character, identity:100+i });
  }
  const context = { opts, root, stage, query, db, children, replicas, http, staff, players, parties, servers, agents, sockets, credentials, Agent,
    key, deterministicId, password, histogram, sample, get stopped(){return stopped;}, metric };
  const baselineGc = await gcSnapshot('before-workload');
  await sample('baseline');
  sampleTask = (async()=>{ while(!stopped) { await pause(1000); if(!stopped) await sample('workload'); } })();
  // Attach rejection handler immediately; final await still propagates failures.
  sampleTask.catch(()=>{stopped=true;});
  for(const scenario of opts.scenario.split(',')) { if(stopped) throw new Error('Sampling safety stop'); await scenarios[scenario](context); }
  stopped=true; await sampleTask;
  if(interrupted) throw new Error('Performance run interrupted');
  for(const socket of sockets) await socket.close();
  for(const agent of agents) await agent.close();
  const cooldownGc = [baselineGc, await gcSnapshot('cooldown-start')];
  const cooldownEnd = monotonicMs()+opts.cooldown*1000;
  do { await sample('cooldown'); if(monotonicMs()<cooldownEnd) await pause(Math.min(5000,cooldownEnd-monotonicMs())); } while(monotonicMs()<cooldownEnd);
  cooldownGc.push(await gcSnapshot('cooldown-end'));
  await writeFile(`${root}/cooldown-gc.json`,JSON.stringify(cooldownGc,null,2));
  await writeFile(`${root}/sql-profile.json`,JSON.stringify(await Promise.all(alive().map(c=>c.rpc('sqlProfile'))),null,2));
  await writeFile(`${root}/agent-journal.json`,JSON.stringify(agents.map(a=>({commands:[...a.commands],controls:[...a.controls]})),null,2));
  await writeFile(`${root}/timeline.json`,JSON.stringify(await Promise.all(alive().map(c=>c.rpc('timeline')))));
  const diff = await dataSource.driver.createSchemaBuilder().log();
  const correctness = await verify(context);
  const schema = { migrations:dataSource.migrations.length, applied:(await query('SELECT count(*)::int AS n FROM migrations'))[0].n,
    pending:await dataSource.showMigrations(), synchronize:dataSource.options.synchronize, diff:{up:diff.upQueries.length,down:diff.downQueries.length} };
  const result = { environment:meta, stages, correctness, schema, baseline:samples[0], cooldown:samples.at(-1), endedAt:new Date().toISOString() };
  await writeFile(`${root}/result.json`,JSON.stringify(result,null,2));
  if(!correctness.ok || schema.pending || diff.upQueries.length || diff.downQueries.length || stages.some(s=>s.errors)) throw new Error('Performance acceptance failed; inspect result.json');
  console.log(JSON.stringify({done:true,output:root,correctness,schema}));
} catch(error) {
  await writeFile(`${root}/failure.json`,JSON.stringify({message:error.message,stack:error.stack},null,2)); console.error(error); process.exitCode=1;
} finally {
  stopped=true; await sampleTask?.catch(()=>{});
  for(const socket of sockets) await socket.close().catch(()=>{});
  for(const agent of agents) await agent.close().catch(()=>{});
  http?.close();
  for(const node of children) { if(node.child.connected) await node.rpc('stop').catch(()=>node.child.kill('SIGTERM')); else node.child.kill('SIGTERM'); }
  if(dataSource?.isInitialized) await dataSource.destroy(); if(db) await db.end();
  if(created) {
    await until(async()=>Number((await admin.query('SELECT count(*) n FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0].n)===0,10000);
    await admin.query(`DROP DATABASE "${dbName}"`);
  }
  await admin.end();
}
async function verify(c) {
  const [r] = await query(`SELECT
    (SELECT count(*)::int FROM (SELECT game_command_id FROM game_command_results GROUP BY game_command_id HAVING count(*)>1) x) AS duplicate_results,
    (SELECT count(*)::int FROM (SELECT game_server_id,event_id FROM agent_domain_event_receipts GROUP BY game_server_id,event_id HAVING count(*)>1) x) AS duplicate_receipts,
    (SELECT count(*)::int FROM game_commands WHERE status IN ('PENDING','DISPATCHED','ACKNOWLEDGED')) AS pending_commands,
    (SELECT count(*)::int FROM game_commands WHERE status IN ('TIMEOUT','FAILED')) AS failed_commands,
    (SELECT count(*)::int FROM vip_reward_deliveries WHERE status NOT IN ('SUCCEEDED','CANCELLED')) AS open_vip,
    (SELECT count(*)::int FROM realtime_connection_leases) AS leases,
    (SELECT count(*)::int FROM game_connections WHERE status='CONNECTED') AS sessions,
    (SELECT count(*)::int FROM server_control_operations WHERE status <> 'SUCCEEDED') AS control_not_succeeded,
    (SELECT count(*)::int FROM player_trades WHERE status='AWAITING_GAME_CONFIRMATION') AS open_trades,
    (SELECT count(*)::int FROM player_marketplace_purchases WHERE status='AWAITING_GAME_CONFIRMATION') AS open_purchases,
    (SELECT count(*)::int FROM player_marketplace_listings WHERE status='PENDING_CUSTODY') AS open_custody,
    (SELECT count(*)::int FROM player_marketplace_item_releases WHERE status<>'COMPLETED') AS open_releases`);
  const journal = { commands:agents.reduce((n,a)=>n+a.commands.size,0), controls:agents.reduce((n,a)=>n+a.controls.size,0),
    duplicateEffects:agents.flatMap(a=>[...a.commands.values(),...a.controls.values()]).filter(e=>e.effects>1).length,
    duplicateControls:agents.flatMap(a=>[...a.controls.values()]).filter(e=>e.frames>1).length,
    errors:agents.flatMap(a=>a.errors), maxAgentActive:Math.max(...agents.map(a=>a.maxActive)) };
  const [ledger] = await query(`SELECT (SELECT count(*)::int FROM (SELECT transaction_id FROM economy_entries GROUP BY transaction_id HAVING sum(amount) <> 0 OR count(*) < 2) x) AS unbalanced, (SELECT count(*)::int FROM economy_accounts a WHERE balance <> (SELECT coalesce(sum(amount),0) FROM economy_entries e WHERE e.account_id=a.id)) AS mismatched_balances`);
  const result = { ...r, journal, ledger };
  // Clock/overload cases intentionally produce FAILED/TIMEOUT/UNCERTAIN and
  // closed sessions: judge only the safety invariants (no duplicate effect,
  // no resend of a ServerControl, receipts, ledger, retry identity).
  if (c.safetyOnly) { result.safetyOnly = true; result.ok = ledger.unbalanced===0 && ledger.mismatched_balances===0 && r.duplicate_results===0 && r.duplicate_receipts===0
    && journal.duplicateEffects===0 && journal.duplicateControls===0 && !journal.errors.some(e=>/identity|payload changed/.test(e)); return result; }
  result.ok = ledger.unbalanced===0 && ledger.mismatched_balances===0 && r.duplicate_results===0 && r.duplicate_receipts===0 && r.pending_commands===0 && r.failed_commands===(c.historicalFailures??0) && r.open_vip===0
    && r.open_trades===0 && r.open_purchases===0 && r.open_custody===0 && r.open_releases===0 && r.leases===0 && r.sessions===0 && r.control_not_succeeded===0 && journal.duplicateEffects===0 && journal.duplicateControls===0 && !journal.errors.length;
  return result;
}
