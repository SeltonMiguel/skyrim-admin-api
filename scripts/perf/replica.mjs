import { monotonicMs } from './clock.mjs';
// Performance-only bootstrap. No diagnostic HTTP routes are added to the app.
import 'reflect-metadata';
import { ConcurrencyLimiter } from '../../dist/common/rate-limit/concurrency-limiter.js';
import { RealtimeGateway } from '../../dist/realtime/realtime.gateway.js';
import { RealtimeLeaseService } from '../../dist/cluster/realtime-leases.js';
import { DataSource } from 'typeorm';
import { ActorCommandService } from '../../dist/actor-operations/actor-command.service.js';
import { GameCommandBus } from '../../dist/game-bridge/game-command-bus.js';
import { GameCommandDispatcher } from '../../dist/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../../dist/game-bridge/game-command-receiver.js';
import { GameGateway } from '../../dist/game-bridge/game-gateway.js';
import { VipDeliveryService } from '../../dist/vip-entitlements/vip-delivery.service.js';
import { AgentWorkNotifier } from '../../dist/game-agent/agent-work.notifier.js';
import { Test } from '@nestjs/testing';
import { ServerControlService } from '../../dist/server-control/server-control.service.js';
import { ServerControlDispatcher } from '../../dist/server-control/server-control-dispatcher.js';
import { ServerControlGateway } from '../../dist/server-control/server-control-gateway.js';
import { GameCommandWorker } from '../../dist/game-agent/game-command.worker.js';
import { ServerControlWorker } from '../../dist/server-control/server-control.worker.js';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../dist/app.module.js';
import { setupApp } from '../../dist/setup-app.js';
import { AppExpressAdapter } from '../../dist/common/http/app-express.adapter.js';
import { AppLogger } from '../../dist/observability/app-logger.js';
import { PROVIDER_FETCH } from '../../dist/player-auth/discord-identity.provider.js';
import { GameServerService } from '../../dist/game-bridge/game-server.service.js';
import { CharacterLinkService } from '../../dist/player-characters/character-link.service.js';
import { EconomyService } from '../../dist/economy/economy.service.js';
import { VipEntitlementService } from '../../dist/vip-entitlements/vip-entitlement.service.js';
import { PlayerMarketplaceService } from '../../dist/player-marketplace/player-marketplace.service.js';
import { RateLimiter } from '../../dist/common/rate-limit/rate-limiter.js';
import { ClusterBus } from '../../dist/cluster/cluster-bus.js';
import { RealtimeEventBus } from '../../dist/realtime-events/realtime-event-bus.js';
import { BacklogCollector } from '../../dist/observability/backlog.collector.js';
import { AgentSessionRegistry } from '../../dist/game-agent/agent-session.registry.js';
import { playerActor, systemActor, SystemSource } from '../../dist/actors/actor.contracts.js';

if (!process.send || !/^skyrim_perf_[a-f0-9]{16}$/.test(process.env.DB_DATABASE ?? '') || process.env.PERF_CHILD !== '1')
  throw new Error('Only an isolated performance parent may start this process');
// 12.6B opt-in civil clock control: shifts Date.now()/new Date() of THIS
// process only (BridgeClock, JWT, local windows). hrtime/performance.now,
// timers and PostgreSQL NOW() are untouched, so app-vs-DB and app-vs-app
// skew and forward/backward steps can be injected without touching the host.
let clockOffsetMs = Number(process.env.PERF_CLOCK_OFFSET_MS ?? 0); // steady skew from boot
if (process.env.PERF_CLOCK_CONTROL === '1') {
  const RealDate = Date;
  class ControlledDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + clockOffsetMs); else super(...args); }
    static now() { return RealDate.now() + clockOffsetMs; }
  }
  globalThis.Date = ControlledDate;
}
// Only external Discord I/O is simulated. Real provider validation, HTTP auth,
// password hashing, JWTs, sessions, guards and all coordination remain active.
const module = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(PROVIDER_FETCH).useValue(async (url, init) => {
    if (url.endsWith('/oauth2/token')) {
      const code = new URLSearchParams(init.body).get('code');
      if (!/^perf-\d+$/.test(code ?? '')) return new Response('{}', { status: 401 });
      return Response.json({ access_token: code.slice(5), token_type: 'bearer' });
    }
    return Response.json({ id: init.headers.Authorization.slice(7), global_name: 'Perf Player' });
  }).compile();
const app = module.createNestApplication(new AppExpressAdapter(), { bufferLogs: true });
app.useLogger(app.get(AppLogger));
setupApp(app);
await app.listen(0, '127.0.0.1');
const bus = app.get(ClusterBus);
let received = 0; const busDelays=[];
bus.subscribe('REALTIME', p => { received++;if(p.perfSentMono&&busDelays.length<20000)busDelays.push(monotonicMs()-p.perfSentMono); });
const config = app.get(ConfigService).get('application');
const { database } = config;
const timeline = [];
const record = row => { if(timeline.length<20000) timeline.push({mono:monotonicMs(),...row}); };
// Local monotonic durations; wall time only aligns separate processes.
function trace(Type, method, kind, identify) {
  const target=app.get(Type), original=target[method].bind(target);
  target[method]=async(...args)=>{const start=monotonicMs(),wall=Date.now();
    try {const result=await original(...args);record({kind,wall,start,elapsed:monotonicMs()-start,...identify(args,result)});return result;}
    catch(error){record({kind,wall,start,elapsed:monotonicMs()-start,error:error.code??error.message,...identify(args)});throw error;}
  };
}
trace(ServerControlService,'transact','control-persisted',(_,r)=>({id:r?.operation?.id,created:r?.created}));
trace(ServerControlDispatcher,'dispatch','control-detected',(a,r)=>({id:a[0],outcome:r}));
trace(ActorCommandService,'create','command-created',(_,r)=>({id:r?.command?.id,created:r?.created}));
trace(GameCommandBus,'submit','command-created',(_,r)=>({id:r?.id}));
trace(GameCommandDispatcher,'reserve','command-reserved',(a,r)=>({id:a[0],claimed:!!r?.claim,attempt:r?.command.dispatchAttempts}));
trace(GameGateway,'send','command-sent',a=>({id:a[1].commandId,attempt:a[1].attempt}));
trace(GameCommandReceiver,'acknowledge','command-ack-persisted',a=>({id:a[0].commandId,attempt:a[0].attempt}));
trace(RealtimeGateway,'authorize','staff-fence',()=>({}));
trace(RealtimeGateway,'deliverPlayers','player-fence-and-fanout',()=>({}));
trace(RealtimeLeaseService,'renew','lease-renew',()=>({}));
const admission={}; const limiter=app.get(ConcurrencyLimiter),acquire=limiter.tryAcquire.bind(limiter);
limiter.tryAcquire=(kind,max)=>{const release=acquire(kind,max);const row=admission[kind]??={accepted:0,rejected:0,peak:0,max};
  row[release?'accepted':'rejected']++;row.peak=Math.max(row.peak,limiter.running(kind));return release;};
const pool=app.get(DataSource).driver.master;
const queries=new Map(),queryParams=new Map();
{
  const profileSql=process.env.PERF_SQL_PROFILE==='1';
  const driver=app.get(DataSource).driver,create=driver.createQueryRunner.bind(driver);
  driver.createQueryRunner=(...args)=>{const runner=create(...args),query=runner.query.bind(runner);
    runner.query=async(sql,params,...rest)=>{
      const claim=/^UPDATE \"server_control_operations\" SET .*\"dispatch_claimed_at\"/.test(sql);
      if(!profileSql&&!claim)return query(sql,params,...rest);
      const start=monotonicMs();try{return await query(sql,params,...rest);}finally{
      if(claim){const parameter=/(?:\b|\")id\"?\s*=\s*\$(\d+)/.exec(sql);record({kind:'control-claim',id:parameter?params[Number(parameter[1])-1]:undefined,start,elapsed:monotonicMs()-start});}
      if(profileSql&&(queries.size<200||queries.has(sql))){const row=queries.get(sql)??{sql,count:0,totalMs:0,maxMs:0};const ms=monotonicMs()-start;row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);queries.set(sql,row);if(!queryParams.has(sql))queryParams.set(sql,params);}
    }};return runner;};
}
let poolPeak=0,poolChecks=0,poolWaitChecks=0;
const poolTimer=setInterval(()=>{poolChecks++;poolPeak=Math.max(poolPeak,pool.waitingCount);if(pool.waitingCount)poolWaitChecks++;},20);
poolTimer.unref();
for(const [Type,interval] of [[GameCommandWorker,config.gameBridge.workerIntervalMs],[ServerControlWorker,config.serverControl.workerIntervalMs],[VipDeliveryService,config.vipDelivery.workerIntervalMs],[AgentWorkNotifier,config.agent.workPushIntervalMs]]) {
  const worker=app.get(Type), original=worker.tick.bind(worker); let previous=monotonicMs();
  worker.tick=async()=>{const start=Date.now(),startMono=monotonicMs(),delay=Math.max(0,startMono-previous-interval);previous=startMono;
    const value=await original();record({kind:'tick',worker:Type.name,start,startMono,elapsed:monotonicMs()-startMono,civilClockDeltaMs:Date.now()-start,delay,processed:value});return value;};
}
// 12.6B: the former PERF_CONTROL_WAKE experiment is superseded by the
// production SERVER_CONTROL_WORK hint; a second, artificial hint would no
// longer measure the real implementation. PERF_CONTROL_HINT_DROP=1 drops the
// production hint in this process (lost-hint / polling-only control).
if (process.env.PERF_CONTROL_WAKE === '1')
  throw new Error('PERF_CONTROL_WAKE is superseded by the production SERVER_CONTROL_WORK hint');
bus.subscribe('SERVER_CONTROL_WORK',()=>record({kind:'control-hint-received'}));
{
  const publish=bus.publish.bind(bus),drop=process.env.PERF_CONTROL_HINT_DROP==='1';
  bus.publish=async(kind,payload)=>{
    if(kind==='SERVER_CONTROL_WORK'){record({kind:drop?'control-hint-dropped':'control-hint-published',payloadKeys:Object.keys(payload).length});if(drop)return;}
    return publish(kind,payload);};
}
// 12.6B: PERF_COMMAND_WAKE is likewise superseded by the production
// GAME_COMMAND_WORK hint. PERF_COMMAND_HINT_DROP=1 turns the production
// announcement (local wake and bus hint) into a no-op in this process
// (polling-only control, SINGLE and MULTI).
if (process.env.PERF_COMMAND_WAKE === '1')
  throw new Error('PERF_COMMAND_WAKE is superseded by the production GAME_COMMAND_WORK hint');
bus.subscribe('GAME_COMMAND_WORK',()=>record({kind:'command-hint-received'}));
{
  const commands=app.get(GameCommandBus),announce=commands.announce.bind(commands),drop=process.env.PERF_COMMAND_HINT_DROP==='1';
  commands.announce=()=>{record({kind:drop?'command-hint-dropped':'command-hint-published'});if(!drop)announce();};
}
const gateway=app.get(ServerControlGateway),send=gateway.send.bind(gateway);
gateway.send=async(request,signal)=>{const sentAt=Date.now(),sentMono=monotonicMs();const value=await send(request,signal);
  record({kind:'control-send',operationId:request.operationId,sentAt,sentMono,notAfter:request.notAfter,elapsed:monotonicMs()-sentMono});return value;};
// Allowlist for metadata; never serialize authentication configuration.
process.send({ ready: true, port: app.getHttpServer().address().port, pid: process.pid,
  config: { deployment: config.deployment, cluster: config.cluster, gameBridge: config.gameBridge,
    serverControl: config.serverControl, agent: config.agent, vipDelivery: config.vipDelivery,
    pool: database.poolMax, security:config.security, databaseTimeouts:{connect:database.connectTimeoutMs,query:database.queryTimeoutMs,statement:database.statementTimeoutMs}, collectionIntervalMs: config.observability.collectionIntervalMs } });
process.on('message', async ({ id, op, args = {} }) => {
  try {
    let value;
    switch (op) {
      case 'server': value = await app.get(GameServerService).register(args); break;
      case 'link': {
        const link = await app.get(CharacterLinkService).request(playerActor(args.playerId), {
          gameServerId: args.serverId, characterExternalId: args.character });
        await app.get(CharacterLinkService).confirmFromAgent({ challenge: link.challenge,
          gameServerId: args.serverId, characterExternalId: args.character });
        await app.get(EconomyService).creditFromSystem({ gameServerId: args.serverId,
          characterExternalId: args.character, amount: 1000000, idempotencyKey: `seed:${args.character}`,
          source: SystemSource.AGENT });
        value = { id: link.link.id }; break;
      }
      case 'grant': value = await app.get(VipEntitlementService).grant({ offerId: args.offerId,
        target: { scope: 'CHARACTER', gameServerId: args.serverId, characterExternalId: args.character },
        actor: systemActor(SystemSource.VIP_DELIVERY), idempotencyKey: args.key }); break;
      case 'listings': {
        value = [];
        for (let i = 0; i < args.count; i++) value.push(await app.get(PlayerMarketplaceService).create(
          playerActor(args.playerId), `${args.key}:${i}`, { characterLinkId: args.linkId,
            itemId: `item:${i}`, quantity: 1, priceGold: 1 }));
        break;
      }
      case 'limit': value = await app.get(RateLimiter).consume('perf-probe', args.key,
        { limit: args.limit ?? 10, windowMs: args.windowMs ?? 1000 }); break;
      case 'publish': app.get(RealtimeEventBus).publish(args.type, args.data, args.recipients); value = true; break;
      case 'bus': await bus.publish('REALTIME', args); value = received; break;
      case 'busState': value = { received, connected: bus.connected, pid: bus.listenerPid,latencies:busDelays }; break;
      case 'collect': { const start = monotonicMs(); await app.get(BacklogCollector).collect(); value = monotonicMs() - start; break; }
      case 'explainHotQueries': {
        const candidates=[...queries.values()].filter(r=>r.count>100&&/^SELECT /i.test(r.sql)&&/ FROM /i.test(r.sql)&&!/(FOR UPDATE|pg_)/i.test(r.sql)).sort((a,b)=>b.totalMs-a.totalMs).slice(0,5);
        value=[];for(const row of candidates)value.push({...row,plan:await app.get(DataSource).query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${row.sql}`,queryParams.get(row.sql))});break;
      }
      case 'sqlProfile': value=[...queries.values()].sort((a,b)=>b.totalMs-a.totalMs); break;
      case 'timeline': value=timeline; break;
      case 'clock': if (process.env.PERF_CLOCK_CONTROL !== '1') throw new Error('Clock control disabled'); clockOffsetMs = args.offsetMs; value = { offsetMs: clockOffsetMs, now: Date.now() }; break;
      case 'gc': if (!globalThis.gc) throw new Error('Start with PERF_EXPOSE_GC=1'); globalThis.gc(); globalThis.gc(); value = process.memoryUsage(); break;
      case 'realtime': { const g=app.get(RealtimeGateway); value = { registry: g.registry?.count?.() ?? null, leases: g.leases?.size ?? null, staffTokens: g.staffTokens?.size ?? null, checks: g.checks?.size ?? null, revoked: g.revoked?.size ?? null }; break; }
      case 'state': value = { mono:monotonicMs(),wall:Date.now(),memory: process.memoryUsage(), resources: process.getActiveResourcesInfo(),
        admission, pool:{waiting:pool.waitingCount,peak:poolPeak,checks:poolChecks,waitChecks:poolWaitChecks,total:pool.totalCount}, agentSessions: app.get(AgentSessionRegistry).count(), cpu: process.cpuUsage() }; break;
      case 'stop': clearInterval(poolTimer); await app.close(); process.send({ id, value: true }); process.disconnect(); return;
      default: throw new Error('Unknown performance diagnostic');
    }
    process.send({ id, value });
  } catch (error) { process.send({ id, error: error.message }); }
});

process.on('disconnect',()=>{ void app.close().finally(()=>process.exit(0)); });
