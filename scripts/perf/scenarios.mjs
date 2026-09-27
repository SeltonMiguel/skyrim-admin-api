import { monotonicMs } from './clock.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Socket, pause, until } from './client.mjs';

const mono = () => monotonicMs();
const node = c => c.opts.replicas - 1; // Agent is always on A; HTTP goes to B in MULTI.
const playerOptions = (c,p,body) => ({ method:'POST', body, token:p.session.accessToken, identity:p.identity, node:node(c), key:c.key() });
async function listing(c, p = c.parties[0]) {
  return c.http.ok('player/marketplace/listings',playerOptions(c,p,{characterLinkId:p.link,itemId:'item:perf',quantity:1,priceGold:1}),201);
}
function ack(r) { assert.equal(r.type,'DOMAIN_EVENT_ACK',JSON.stringify(r)); return r; }
async function domain(c, workId, eventId = c.deterministicId(c.key()), kind = 'MARKETPLACE_CUSTODY') {
  return ack(await c.agents[0].event(kind,{workId,outcome:kind==='MARKETPLACE_RELEASE'?'RELEASED':kind==='MARKETPLACE_SETTLEMENT'?'SETTLED':'SUCCEEDED'},eventId));
}
async function gameCommand(c,lane=0) {
  const index=lane%c.servers.length; const submittedMono=mono();
  const r = await c.http.call(`game-servers/${c.servers[index].id}/characters/perf:character:0/inventory/items/give`,
    {method:'POST',body:{itemId:'item:perf',quantity:1},token:c.staff.accessToken,node:node(c),key:c.key()});
  if(r.status!==202) return r;
  c.submissions??=new Map();c.submissions.set(r.body.commandId,{submittedMono,acceptedMono:mono()});
  c.submitLatencies ??= []; c.submitLatencies.push(r.ms);
  await until(()=>c.agents[index].commands.get(r.body.commandId)?.completedAt,45000);
  return {status:200};
}
async function control(c,lane=0) {
  const submittedMono=mono();
  const r=await c.http.call(`game-servers/${c.servers[lane%c.servers.length].id}/control/restart`,
    {method:'POST',body:{},token:c.staff.accessToken,node:node(c),key:c.key()});
  if(r.status!==202) return r;
  c.controlSubmissions??=new Map();c.controlSubmissions.set(r.body.operationId,{submittedMono,acceptedMono:mono()});
  await until(()=>c.agents[lane%c.agents.length].controls.get(r.body.operationId)?.completedAt);
  return {status:200};
}
async function commandTimings(c) {
  const rows=await c.query(`SELECT id,status,dispatch_attempts, EXTRACT(EPOCH FROM(last_dispatch_at-created_at))*1000 AS dispatch_ms,
    EXTRACT(EPOCH FROM(acknowledged_at-last_dispatch_at))*1000 AS ack_ms,
    EXTRACT(EPOCH FROM(completed_at-created_at))*1000 AS total_ms FROM game_commands`);
  const traces=(await Promise.all(c.children.map(child=>child.rpc('timeline')))).flat();
  const monotonic=rows.map(r=>{const entries=traces.filter(t=>t.id===r.id),journal=c.agents.flatMap(a=>[...a.commands.entries()]).find(([id])=>id===r.id)?.[1];
    return {id:r.id,...c.submissions?.get(r.id),created:entries.find(t=>t.kind==='command-created')?.mono,
      reserved:entries.find(t=>t.kind==='command-reserved'&&t.claimed)?.mono,sent:entries.find(t=>t.kind==='command-sent')?.start,
      received:journal?.receivedMono,ackEmitted:journal?.ackEmittedMono,ackPersisted:entries.find(t=>t.kind==='command-ack-persisted'&&!t.error)?.mono};});
  const result={monotonic,submit:c.histogram(c.submitLatencies??[]),count:rows.length,statuses:{},attempts:{},
    dispatch:c.histogram(rows.map(r=>Number(r.dispatch_ms))),ack:c.histogram(rows.filter(r=>r.ack_ms!==null).map(r=>Number(r.ack_ms))),
    total:c.histogram(rows.map(r=>Number(r.total_ms)))};
  for(const r of rows){result.statuses[r.status]=(result.statuses[r.status]??0)+1;result.attempts[r.dispatch_attempts]=(result.attempts[r.dispatch_attempts]??0)+1;}
  await writeFile(`${c.root}/commands.json`,JSON.stringify(result,null,2));
}
async function controlTimings(c) {
  const rows=await c.query('SELECT id,created_at,dispatch_claimed_at,dispatched_at,not_after,result_deadline_at,completed_at,status,error_code FROM server_control_operations');
  const timeline=(await Promise.all(c.children.map(child=>child.rpc('timeline')))).flat();
  const timings=rows.map(r=>{const journal=c.agents.flatMap(a=>[...a.controls.entries()]).find(([id])=>id===r.id)?.[1];
    const send=timeline.find(t=>t.kind==='control-send'&&t.operationId===r.id);
    const persisted=timeline.find(t=>t.kind==='control-persisted'&&t.id===r.id&&t.created);
    const detected=timeline.find(t=>t.kind==='control-detected'&&t.id===r.id&&t.outcome==='SENT');
    const claim=timeline.find(t=>t.kind==='control-claim'&&t.id===r.id);
    return {...r,persistedMono:persisted?.mono,persistDurationMs:persisted?.elapsed,detectedMono:detected?.start,claimStartMono:claim?.start,claimEndMono:claim?.mono,claimDurationMs:claim?.elapsed,sentMono:send?.sentMono,claimToSendMs:send?.sentAt-r.dispatch_claimed_at,deliveryWindowMs:r.not_after-r.dispatch_claimed_at,remainingAtSendMs:r.not_after-send?.sentAt,...c.controlSubmissions?.get(r.id),receivedMono:journal?.receivedMono,agentReceivedAt:journal?.receivedAt,createdToClaimMs:r.dispatch_claimed_at-r.created_at,
      claimToReceivedMs:journal?.receivedAt-r.dispatch_claimed_at,remainingWindowMs:r.not_after-journal?.receivedAt,
      totalMs:r.completed_at-r.created_at};});
  await writeFile(`${c.root}/controls.json`,JSON.stringify(timings,null,2));
}
async function trade(c) {
  const [a,b]=c.parties;
  const created=await c.http.ok('player/trades',playerOptions(c,a,{actorCharacterLinkId:a.link,targetCharacterId:b.character,
    offer:{gold:3,items:[{itemId:'item:sword',quantity:1}]}}),201);
  const view=await c.http.ok(`player/trades/${created.tradeId}?characterLinkId=${a.link}`,{token:a.session.accessToken,node:node(c)});
  for(const [p,version] of [[a,view.target.offer.version],[b,view.initiator.offer.version]])
    await c.http.ok(`player/trades/${created.tradeId}/accept`,playerOptions(c,p,{characterLinkId:p.link,counterpartyOfferVersion:version}));
  await domain(c,created.tradeId,undefined,'TRADE_SETTLEMENT');
  return created.tradeId;
}
async function market(c,release=false) {
  const item=await listing(c); await domain(c,item.listingId);
  const p=c.parties[release?0:1];
  if(release) {
    await c.http.ok(`player/marketplace/listings/${item.listingId}/cancel`,playerOptions(c,p,{characterLinkId:p.link}));
    const sync=await c.agents[0].sync({kind:'MARKETPLACE_RELEASE'});
    const work=sync.payload.items.find(w=>w.data.listingId===item.listingId);
    assert.ok(work); await domain(c,work.workId,undefined,'MARKETPLACE_RELEASE');
  } else {
    const purchase=await c.http.ok(`player/marketplace/listings/${item.listingId}/purchase`,playerOptions(c,p,{characterLinkId:p.link}),201);
    await domain(c,purchase.purchaseId,undefined,'MARKETPLACE_SETTLEMENT');
  }
}
async function vipOffer(c) {
  if(!c.offer) c.offer=await c.http.ok('admin/vip-store/offers',{method:'POST',token:c.staff.accessToken,body:{code:`perf_${c.opts.seed}`,
    name:'Performance',description:'Local fixture',priceMinor:1,currency:'BRL',rewards:[{type:'TITLE',titleId:'title:perf'}],
    entitlementScope:'CHARACTER',active:true}},201);
  return c.offer;
}
async function grant(c) {
  const offer=await vipOffer(c),key=c.key();
  const result=await c.children[node(c)].rpc('grant',{offerId:offer.id,serverId:c.servers[0].id,character:`perf:vip:${key}`,key});
  assert.equal(result.outcome,'GRANTED'); return result;
}
async function realtime(c,churn=false) {
  const clients=[]; let events=0; const delays=[],connect=[];const started=monotonicMs();
  // 5 sockets per principal is the unchanged cluster cap. Distinct loopback
  // source IPs model distinct clients, not a forged X-Forwarded-For header.
  for(let i=0;i<Math.min(c.opts.concurrency,40);i++) {
    const player=i%2===0;
    if(!player&&clients.filter(s=>s.surface==='STAFF').length>=5)continue;
    const connectionStart=monotonicMs();
    const client=new Socket(c.replicas[0].port,'realtime',300+i);
    c.sockets.push(client); clients.push(client);
    const token=player?c.players[Math.floor(i/2)%8].accessToken:c.staff.accessToken;
    // Use at most 5 Staff sockets (one account), rest are Players.
    client.surface=player?'PLAYER':'STAFF'; await client.auth(client.surface,token);connect.push(monotonicMs()-connectionStart);
    client.listeners.add(f=>{if(f.data?.sentAt){events++;delays.push(mono()-f.data.sentMono);}});
  }
  if(churn) {
    for(const s of clients) await s.close();
    await c.stage('realtime-churn',async(lane,i)=>{
      const p=c.players[lane%c.players.length]; const s=new Socket(c.replicas[lane%c.replicas.length].port,'realtime',400+lane);
      await s.auth('PLAYER',p.accessToken); await s.close(); return {status:200};
    },Math.min(c.opts.concurrency,4),c.opts.duration,1100);
  } else await c.stage('realtime-fanout',async()=>{
    const data={sentAt:Date.now(),sentMono:mono()};
    await c.children[node(c)].rpc('publish',{type:'PLAYER_SETTINGS_UPDATED',data,recipients:{playerIds:c.players.map(p=>p.player.id)}});
    await c.children[node(c)].rpc('publish',{type:'STAFF_OPERATIONS_UPDATED',data,recipients:{staffPermission:'OPERATIONS_READ'}});
    return {status:200};
  },1,c.opts.duration,100);
  await pause(250);
  await writeFile(`${c.root}/realtime-${churn?'churn':'fanout'}.json`,JSON.stringify({clients:clients.length,events,eventsPerSecond:events/((monotonicMs()-started)/1000),connectAuthMs:c.histogram(connect),latency:c.histogram(delays)},null,2));
  for(const s of clients) await s.close();
}
// 12.6B clock-step/skew cases. Each case runs in a fresh isolated database.
async function clockCase(c){
  const kase=process.env.PERF_CLOCK_CASE;const A=0,B=c.opts.replicas-1;c.safetyOnly=true;
  const out={case:kase,topology:c.opts.replicas===2?'MULTI':'SINGLE',events:[],commands:[],controls:[]};const t0=mono();
  const note=(e,extra={})=>{out.events.push({atMs:Math.round(mono()-t0),e,...extra});};
  const setClock=async(i,offsetMs)=>{await c.children[i].rpc('clock',{offsetMs});note('clock',{replica:i?'B':'A',offsetMs});};
  const submit=async(k=0)=>{const r=await c.http.call(`game-servers/${c.servers[k].id}/characters/perf:character:0/inventory/items/give`,
    {method:'POST',body:{itemId:'item:perf',quantity:1},token:c.staff.accessToken,node:B,key:c.key()});assert.equal(r.status,202,JSON.stringify(r.body));return r.body.commandId;};
  const submitControl=async(k=0)=>{const r=await c.http.call(`game-servers/${c.servers[k].id}/control/restart`,
    {method:'POST',body:{},token:c.staff.accessToken,node:B,key:c.key()});assert.equal(r.status,202,JSON.stringify(r.body));return r.body.operationId;};
  const agentOf=id=>c.agents.find(a=>a.commands.has(id)||a.controls.has(id));
  const received=id=>until(()=>agentOf(id),20000);
  const settle=async(table,ids,terminal,timeout=90000)=>until(async()=>{const rows=await c.query(`SELECT id,status FROM ${table} WHERE id = ANY($1)`,[ids]);
    return rows.length===ids.length&&rows.every(r=>terminal.includes(r.status));},timeout).catch(()=>false);
  const commandReport=async ids=>{const rows=await c.query('SELECT id,status,dispatch_attempts FROM game_commands WHERE id = ANY($1)',[ids]);
    for(const r of rows){const j=agentOf(r.id)?.commands.get(r.id);out.commands.push({status:r.status,attempts:r.dispatch_attempts,
      agentFrames:j?.frames??0,effects:j?.effects??0,retryGapsMs:j?j.attemptsMono.slice(1).map((m,i)=>Math.round(m-j.attemptsMono[i])):[]});}};
  const controlReport=async ids=>{const rows=await c.query('SELECT id,status,error_code,dispatch_claimed_at,not_after,created_at,completed_at FROM server_control_operations WHERE id = ANY($1)',[ids]);
    for(const r of rows){const j=agentOf(r.id)?.controls.get(r.id);out.controls.push({status:r.status,errorCode:r.error_code,claimed:!!r.dispatch_claimed_at,
      persistedWindowMs:r.not_after?r.not_after-r.dispatch_claimed_at:null,agentRemainingMs:j?Math.round(j.agentRemainingMs):null,frames:j?.frames??0,effects:j?.effects??0,
      createdToCompletedPersistedMs:r.completed_at?r.completed_at-r.created_at:null});}};
  const sessions=async()=>(await c.query("SELECT status,count(*)::int n FROM game_connections GROUP BY status")).reduce((o,r)=>({...o,[r.status]:r.n}),{});
  const closedAgents=()=>c.agents.map(a=>a.closed?a.closed.code:null);
  const latency=ms=>{for(const a of c.agents)a.latency=ms;};
  const inflight=async(ids,offset,replica=A)=>{for(const id of ids)await received(id);await setClock(replica,offset);};
  const T=['SUCCEEDED','FAILED','TIMEOUT'],CT=['SUCCEEDED','FAILED','UNCERTAIN'];
  switch(kase){
    case 'baseline':{const ids=[];for(let i=0;i<4;i++)ids.push(await submit(i%2));const ops=[await submitControl(0),await submitControl(1)];
      await settle('game_commands',ids,T);await settle('server_control_operations',ops,CT);await commandReport(ids);await controlReport(ops);break;}
    case 'retry-reference':{// No step: attempt gap with an Agent that never ACKs in time.
      for(const a of c.agents)a.latency=15000;const id=await submit(0);await received(id);
      await until(()=>agentOf(id).commands.get(id).attemptsMono.length>=2,30000);await settle('game_commands',[id],T);await commandReport([id]);break;}
    case 'small-step':{// Observed magnitude (~1.2 s), forward then back, on both replicas while commands/controls are in flight.
      latency(1000);const ids=[];for(let i=0;i<8;i++)ids.push(await submit(i%2));const ops=[await submitControl(0),await submitControl(1)];
      await inflight(ids.slice(0,2),1200,A);if(B!==A)await setClock(B,1200);await pause(3000);await setClock(A,0);if(B!==A)await setClock(B,0);
      await settle('game_commands',ids,T);await settle('server_control_operations',ops,CT);await commandReport(ids);await controlReport(ops);break;}
    case 'forward-owner':{// Owner A jumps +8 s while commands wait for ACK; then controls under steady A+8 vs B.
      latency(2500);const ids=[];for(let i=0;i<4;i++)ids.push(await submit(i%2));await inflight(ids,8000,A);
      await settle('game_commands',ids,T);latency(0);
      const ops=[await submitControl(0),await submitControl(1)];await settle('server_control_operations',ops,CT);
      await commandReport(ids);await controlReport(ops);out.sessions=await sessions();out.agentsClosed=closedAgents();break;}
    case 'forward-owner-result':{// Scaled result timeout (env SERVER_CONTROL_RESULT_TIMEOUT_MS): step passes it while the Agent still executes.
      latency(2500);const ops=[await submitControl(0),await submitControl(1)];for(const id of ops)await received(id);
      await setClock(A,Number(process.env.PERF_CLOCK_STEP_MS??7000));await settle('server_control_operations',ops,CT);await pause(4500);await controlReport(ops);
      out.agentReplies=ops.map(id=>agentOf(id)?.controls.get(id)?.reply??null);break;}
    case 'forward-owner-large':{// +35 s > heartbeat timeout (30 s) on the owner.
      const before=mono();await setClock(A,35000);
      await until(()=>c.agents.every(a=>a.closed),15000).catch(()=>false);note('agents-closed',{afterMs:Math.round(mono()-before),codes:closedAgents()});
      const id=await submit(0);await pause(3000);const [row]=await c.query('SELECT status,dispatch_attempts FROM game_commands WHERE id=$1',[id]);
      out.heldCommand=row;out.sessions=await sessions();break;}
    case 'backward-owner':{// Reference gap first, then A steps -8 s while the next command waits for ACK.
      for(const a of c.agents)a.latency=15000;const ref=await submit(0);await received(ref);
      await until(()=>agentOf(ref).commands.get(ref).attemptsMono.length>=2,30000);const id=await submit(1);await received(id);await setClock(A,-8000);
      await until(()=>agentOf(id).commands.get(id).attemptsMono.length>=2,40000);await settle('game_commands',[ref,id],T);await commandReport([ref,id]);
      out.sessions=await sessions();out.agentsClosed=closedAgents();break;}
    case 'backward-owner-large':{// -35 s on the owner A, B stays correct: B's DB sweep sees A's heartbeats as old.
      const before=mono();await setClock(A,-35000);
      await until(()=>c.agents.every(a=>a.closed),40000).catch(()=>false);note('agents-closed',{afterMs:Math.round(mono()-before),codes:closedAgents()});
      out.sessions=await sessions();break;}
    case 'backward-rate-window':{// Legit Agent traffic at 12 frames/s (limit 200/10 s) before and after a -35 s step.
      const run=async(label,seconds)=>{const start=mono();let sent=0;while(mono()-start<seconds*1000&&!c.agents[0].closed){await c.agents[0].sync().catch(()=>{});sent++;await pause(80);}
        note(label,{sent,closed:c.agents[0].closed||null,seconds:Math.round((mono()-start)/100)/10});};
      await run('reference-no-step',25);await setClock(A,-35000);await run('after-backward-step',30);out.agentsClosed=closedAgents();break;}
    case 'skew-http-replica':{// B (HTTP/creator) behind by 35 s, A (owner/worker) correct.
      await setClock(B,-35000);const ops=[await submitControl(0),await submitControl(1)];const ids=[await submit(0),await submit(1)];
      await settle('server_control_operations',ops,CT);await settle('game_commands',ids,T);await controlReport(ops);await commandReport(ids);
      await setClock(B,35000);const ahead=[await submitControl(0)];await settle('server_control_operations',ahead,CT);await controlReport(ahead);break;}
    case 'agent-skew':{// Agent 0 ahead +12 s, Agent 1 behind -12 s; backend correct. notAfter window = 10 s.
      c.agents[0].clockOffsetMs=12000;c.agents[1].clockOffsetMs=-12000;const ops=[await submitControl(0),await submitControl(1)];
      await settle('server_control_operations',ops,CT);await controlReport(ops);break;}
    case 'db-skew':{// Steady skew from boot (PERF_CLOCK_OFFSET_MS on both replicas, Agent shares the app clock):
      // app deadlines vs DB-owned leases/bus/limiter and the few app-written vs NOW() comparisons.
      const skew=Number(process.env.PERF_CLOCK_OFFSET_MS);assert.ok(skew);for(const a of c.agents)a.clockOffsetMs=skew;out.skewMs=skew;
      const ids=[];for(let i=0;i<6;i++)ids.push(await submit(i%2));const ops=[await submitControl(0),await submitControl(1)];
      const s=new Socket(c.replicas[A].port,'realtime',720);c.sockets.push(s);await s.auth('PLAYER',c.players[0].accessToken);
      let got=0;s.listeners.add(f=>{if(f.type==='PLAYER_SETTINGS_UPDATED')got++;});
      // pt-BR is the default locale: an unchanged PATCH publishes nothing.
      await c.http.ok('player/settings',{method:'PATCH',token:c.players[0].accessToken,node:B,key:c.key(),body:{locale:'en-US'}});
      await until(()=>got>0,10000);const shared=c.key();
      const limit=await Promise.all(Array.from({length:100},(_,i)=>c.children[i%c.opts.replicas].rpc('limit',{key:shared,windowMs:60000,limit:10})));
      const [lease]=await c.query('SELECT count(*)::int n, min(EXTRACT(EPOCH FROM (expires_at-now())))::float8 ttl FROM realtime_connection_leases');
      await settle('game_commands',ids,T);await settle('server_control_operations',ops,CT);await commandReport(ids);await controlReport(ops);
      out.realtimeDelivered=got;out.limiterAdmitted=limit.filter(r=>r.allowed).length;out.lease=lease;await s.close();break;}
    default: throw new Error('Unknown PERF_CLOCK_CASE');
  }
  out.sessionsEnd=await sessions();out.agentErrors=c.agents.flatMap(a=>a.errors).slice(0,10);
  await writeFile(`${c.root}/clock.json`,JSON.stringify(out,null,2));
}
// 12.6B realtime churn/leak: rounds of connect->auth->receive->disconnect,
// each followed by idle + explicit GC, comparing post-idle baselines.
async function leak(c){
  const rounds=Number(process.env.PERF_LEAK_ROUNDS??3),seconds=Number(process.env.PERF_LEAK_SECONDS??60),idle=Number(process.env.PERF_LEAK_IDLE??45);
  // Pause per cycle keeps the total connect rate under the per-IP limit.
  const pace=Number(process.env.PERF_LEAK_PACE_MS??0);
  const snapshot=async label=>{const gc=await Promise.all(c.children.map(ch=>ch.rpc('gc').catch(()=>null)));
    const state=await Promise.all(c.children.map(ch=>ch.rpc('state')));const rt=await Promise.all(c.children.map(ch=>ch.rpc('realtime')));
    const [t]=await c.query('SELECT (SELECT count(*)::int FROM realtime_connection_leases) leases,(SELECT count(*)::int FROM distributed_bus_events) bus,(SELECT count(*)::int FROM rate_limit_buckets) buckets');
    const count=r=>r.resources.reduce((o,k)=>({...o,[k]:(o[k]??0)+1}),{});
    return {label,atMs:Math.round(mono()),replicas:state.map((s,i)=>({rss:s.memory.rss,heapUsed:gc[i]?.heapUsed??s.memory.heapUsed,heapTotal:s.memory.heapTotal,external:s.memory.external,resources:count(s),realtime:rt[i]})),tables:t};};
  const out={rounds:[],cycles:0,received:0,failures:0,connect:[]};out.rounds.push(await snapshot('before'));
  let identity=0;
  for(let r=0;r<rounds;r++){
    const lanes=Math.min(8,c.opts.concurrency);const end=mono()+seconds*1000;
    await Promise.all(Array.from({length:lanes},async(_,lane)=>{while(mono()<end&&!c.stopped){
      const p=c.players[lane%c.players.length];const at=c.opts.replicas>1?lane%2:0,pub=c.opts.replicas>1?1-at:0;
      const start=mono();const s=new Socket(c.replicas[at].port,'realtime',800+(identity++%96));
      try{await s.auth('PLAYER',p.accessToken);out.connect.push(mono()-start);
        const got=s.wait('PLAYER_SETTINGS_UPDATED',5000);
        await c.children[pub].rpc('publish',{type:'PLAYER_SETTINGS_UPDATED',data:{sentMono:mono()},recipients:{playerIds:[p.player.id]}});
        await got;out.received++;}catch{out.failures++;}finally{await s.close();out.cycles++;if(pace)await pause(pace);}
    }}));
    await pause(idle*1000);out.rounds.push(await snapshot(`after-round-${r+1}`));
  }
  out.connect=c.histogram(out.connect);await writeFile(`${c.root}/leak.json`,JSON.stringify(out,null,2));
}
// 12.6B short overload above the knee, all subsystems at once; the safety
// stop in run.mjs (RSS, free RAM, in-flight) interrupts before the host suffers.
async function overload(c){
  // Degradation is expected: judge safety invariants, record the backlog.
  c.safetyOnly=true;const d=c.opts.duration,reads=['dashboard','player/game-servers','player/me/characters','operations/domain-event-receipts?limit=50'];
  const [readStage,commandStage,controlStage,loginStage,chatStage]=await Promise.all([
    c.stage('overload-reads',(lane,i)=>{const url=reads[i%reads.length];return c.http.call(url,{token:url.startsWith('player')?c.players[0].accessToken:c.staff.accessToken,node:lane%c.opts.replicas});},c.opts.concurrency,d),
    c.stage('overload-gamecommands',lane=>gameCommand(c,lane),16,d),
    c.stage('overload-server-control',lane=>control(c,lane),4,d,50),
    c.stage('overload-staff-login',lane=>c.http.call('auth/login',{method:'POST',node:lane%c.opts.replicas,identity:520+lane,body:{username:`perf${lane%8}`,password:c.password}}),8,d),
    c.stage('overload-chat',(lane,i)=>{const p=c.parties[lane%c.parties.length];return c.http.call('player/chat/global',{method:'POST',token:p.session.accessToken,identity:p.identity,node:lane%c.opts.replicas,key:c.key(),body:{characterLinkId:p.link,message:`burst ${i}`}});},8,d),
  ]);
  const drainStart=mono();
  const drained=await until(async()=>!(await c.query("SELECT count(*)::int n FROM game_commands WHERE status IN ('PENDING','DISPATCHED','ACKNOWLEDGED')"))[0].n,90000).then(()=>true,()=>false);
  const backlog={drained,drainMs:mono()-drainStart,agentsClosed:c.agents.map(a=>a.closed||null),agentErrors:c.agents.flatMap(a=>a.errors).slice(0,5),
    commands:await c.query('SELECT status,count(*)::int n,max(dispatch_attempts)::int max_attempts FROM game_commands GROUP BY 1'),
    controls:await c.query('SELECT status,error_code,count(*)::int n FROM server_control_operations GROUP BY 1,2')};
  await writeFile(`${c.root}/overload-backlog.json`,JSON.stringify(backlog,null,2));
  await commandTimings(c);await controlTimings(c);
  await writeFile(`${c.root}/overload.json`,JSON.stringify([readStage,commandStage,controlStage,loginStage,chatStage].map(r=>({name:r.name,throughput:r.throughput,useful:r.usefulThroughput,statuses:r.statuses,latency:r.latencyMs,success:r.successLatencyMs,maxPoolWaiting:r.maxPoolWaiting,maxEventLoopLag:r.maxEventLoopLag,maxEventLoopStall:r.maxEventLoopStall,maxRss:r.maxRss,appCpuCores:r.appCpuCores,failures:r.failures})),null,2));
}
// 12.6B crash recovery: SIGKILL the owner A (no graceful shutdown). The Agent
// of server 0 reconnects to B at once; server 1's Agent does not reconnect,
// so its row must be closed by B's DB sweep once the heartbeat lease expires.
async function crash(c){
  if(c.opts.replicas!==2)throw new Error('Crash scenario requires MULTI');c.safetyOnly=true;
  const s=new Socket(c.replicas[0].port,'realtime',730);c.sockets.push(s);await s.auth('PLAYER',c.players[0].accessToken);
  const [a]=await c.query("SELECT (SELECT count(*)::int FROM realtime_connection_leases) leases,(SELECT extract(epoch from now()-max(last_heartbeat_at))*1000 FROM game_connections WHERE status='CONNECTED') hb_age_ms");
  const out={before:a};const t=mono();c.children[0].child.kill('SIGKILL');
  await until(()=>c.agents.every(x=>x.closed),10000);out.agentsSawCloseMs=mono()-t;
  const agent=new c.Agent(c.replicas[1].port,c.servers[0].id,210,0);c.agents.push(agent);await agent.hello(c.credentials[0]);out.reconnectedOnBMs=mono()-t;
  // Wait on the reconnected Agent (gameCommand() would watch the killed one).
  const r=await c.http.call(`game-servers/${c.servers[0].id}/characters/perf:character:0/inventory/items/give`,
    {method:'POST',body:{itemId:'item:perf',quantity:1},token:c.staff.accessToken,node:1,key:c.key()});
  assert.equal(r.status,202,JSON.stringify(r.body));
  await until(()=>agent.commands.get(r.body.commandId)?.completedAt,45000);out.commandViaNewOwnerMs=mono()-t;out.commandStatus='SUCCEEDED';
  await until(async()=>(await c.query("SELECT count(*)::int n FROM game_connections WHERE game_server_id=$1 AND status='CONNECTED'",[c.servers[1].id]))[0].n===0,90000);
  out.orphanSessionClosedMs=mono()-t;
  await until(async()=>(await c.query('SELECT count(*)::int n FROM realtime_connection_leases'))[0].n===0,200000);out.orphanLeaseGoneMs=mono()-t;
  const [row]=await c.query("SELECT disconnect_reason FROM game_connections WHERE game_server_id=$1 ORDER BY connected_at DESC LIMIT 1",[c.servers[1].id]);out.orphanReason=row?.disconnect_reason;
  await writeFile(`${c.root}/crash.json`,JSON.stringify(out,null,2));
}
export const scenarios={
  crash,
  overload,
  clock:clockCase,
  leak,
  async reads(c){
    const endpoints=[['health','health'],['readiness','ready'],['admin','dashboard'],['discovery','player/game-servers'],
      ['characters','player/me/characters'],['profile','player/me'],['queue','operations/domain-event-receipts?limit=50']];
    for(const [label,url] of endpoints.filter(([label])=>!c.opts.endpoints||c.opts.endpoints.includes(label))){
      const token=url.startsWith('player')?c.players[0].accessToken:c.staff.accessToken;
      await c.http.ok(url,{token}); // Do not benchmark a misconfigured/404 route.
      let previous;
      const steps=c.opts.profile==='saturation'?[8,16,32,64,128,256].filter(n=>n<=c.opts.concurrency):[c.opts.concurrency];
      for(const concurrency of steps){
        const result=await c.stage(`http-${label}`,lane=>c.http.call(url,{token,node:lane%c.opts.replicas}),concurrency);
        // Stop the ramp on two independent pressure signals or sustained errors.
        if(result.errorRate>.01||result.maxRss>1024**3||result.maxEventLoopLag>.25||
          (previous&&result.latencyMs.p99>previous.latencyMs.p99*4&&result.throughput<previous.throughput*1.2)) break;
        previous=result;
      }
    }
  },
  async sql(c){
    const result=await Promise.all(c.children.map(child=>child.rpc('explainHotQueries')));
    await writeFile(`${c.root}/hot-queries.json`,JSON.stringify(result,null,2));
  },
  async auth(c){
    // Bounded legitimate attempts, then the actual admission protection. No
    // rate limit is raised or reset and 429 never counts as useful throughput.
    for(const concurrency of [1,4,8,16].filter(n=>n<=Math.max(16,c.opts.concurrency))){
      await c.stage(`staff-login-${concurrency}`, (lane,i)=>c.http.call('auth/login',{method:'POST',node:lane%c.opts.replicas,
        identity:500+lane,body:{username:`perf${lane%8}`,password:c.password}}),concurrency,1,250);
    }
    const sessions=[];
    for(let i=0;i<4;i++) sessions.push(await c.http.ok('player/auth/discord/exchange',{method:'POST',identity:600+i,
      body:{authorizationCode:`perf-${c.opts.seed*1000+i}`,redirectUri:'http://127.0.0.1/cb'}}));
    await c.stage('player-login',lane=>c.http.call('player/auth/discord/exchange',{method:'POST',identity:610+lane,node:lane%c.opts.replicas,
      body:{authorizationCode:`perf-${c.opts.seed*1000+lane}`,redirectUri:'http://127.0.0.1/cb'}}),4,c.opts.duration,250);
    for(const surface of ['staff','player']){
      const sessionsForRefresh=surface==='player'?sessions:[c.staff];
      await c.stage(`${surface}-refresh`,async lane=>{
        const s=sessionsForRefresh[lane]; const r=await c.http.call(`${surface==='player'?'player/':''}auth/refresh`,{method:'POST',
          body:{refreshToken:s.refreshToken},identity:650+lane,node:lane%c.opts.replicas});
        if(r.status===200) Object.assign(s,r.body); return r;
      },sessionsForRefresh.length,c.opts.duration,200);
    }
  },
  async commands(c){
    // PERF_COMMAND_STEPS (e.g. 1,2): keep each Agent under its own message
    // rate limit (ACK + RESULT per command) when dispatch is not throttled.
    const steps=(process.env.PERF_COMMAND_STEPS??'1,4,8').split(',').map(Number);
    for(const n of steps.filter(n=>n<=c.opts.concurrency))
      await c.stage('gamecommand-fast-or-delayed',lane=>gameCommand(c,lane),n,c.opts.duration,150);
    await commandTimings(c);
  },
  async control(c){await c.stage('server-control',lane=>control(c,lane),Math.min(8,c.opts.concurrency),c.opts.duration,100);await controlTimings(c);},
  async contention(c){
    for(const reads of [0,8,32]) {
      const background=reads?c.stage(`contention-reads-${reads}`,lane=>c.http.call('dashboard',{token:c.staff.accessToken,node:lane%c.opts.replicas}),reads):Promise.resolve();
      await Promise.all([background,c.stage(`contention-command-control-${reads}`,async lane=>{
        if(lane%2) return control(c,lane); return gameCommand(c,lane);
      },4,c.opts.duration,200)]);
    }
    await commandTimings(c);await controlTimings(c);
  },
  async domain(c){
    const item=await listing(c),data={workId:item.listingId,outcome:'SUCCEEDED'},eventId=c.deterministicId('duplicate');
    await domain(c,item.listingId,eventId);
    for(const concurrency of [1,4]) await c.stage(`domain-duplicate-${concurrency}`,async()=>{
      const r=ack(await c.agents[0].event('MARKETPLACE_CUSTODY',data,eventId)); assert.equal(r.payload.duplicate,true);
      return {status:200};
    },concurrency,c.opts.duration,400);
    await c.stage('domain-normal',async(lane,i)=>{const item=await listing(c,c.parties[i%c.parties.length]);await domain(c,item.listingId);return {status:200};},1,c.opts.duration,400);
    const [r]=await c.query('SELECT count(*)::int AS n FROM agent_domain_event_receipts WHERE event_id=$1',[eventId]);assert.equal(r.n,1);
  },
  async work(c){
    const p=c.parties[0];
    for(const count of [1,49]){
      await c.children[node(c)].rpc('listings',{playerId:p.session.player.id,linkId:p.link,key:c.key(),count});
      let bytes=0,items=0;
      await c.stage(`work-sync-${count===1?1:50}`,async()=>{const r=await c.agents[0].sync();assert.equal(r.type,'WORK_ITEMS');
        bytes=Buffer.byteLength(JSON.stringify(r));items=r.payload.items.length;assert.equal(items,count===1?1:50);return {status:200};},1,c.opts.duration,100);
      await writeFile(`${c.root}/work-${count}.json`,JSON.stringify({bytes,items}));
    }
    const r=await c.agents[0].sync();for(const item of r.payload.items){await domain(c,item.workId);await pause(100);}
  },
  async economy(c){
    await vipOffer(c);
    await c.stage('trade-marketplace-vip',async(_,i)=>{await trade(c);await market(c,i%2===0);await grant(c);return {status:200};},1,c.opts.duration,2000);
    await until(async()=>!(await c.query("SELECT count(*)::int n FROM vip_reward_deliveries WHERE status IN ('PENDING','COMMAND_CREATED')"))[0].n,45000);
    await commandTimings(c);
  },
  async realtime(c){await realtime(c);},
  async churn(c){await realtime(c,true);},
  async limiter(c){
    if(c.opts.replicas!==2) throw new Error('Distributed limiter scenario requires MULTI');
    // Exact contention burst: the same key must admit exactly 10 across A+B.
    const shared=c.key();const results=await Promise.all(Array.from({length:100},(_,i)=>c.children[i%2].rpc('limit',{key:shared,windowMs:60000,limit:10})));
    assert.equal(results.filter(r=>r.allowed).length,10);
    for(const distinct of [false,true]) await c.stage(`limiter-${distinct?'many-keys':'same-key'}`,async(lane,i)=>{
      const r=await c.children[lane%2].rpc('limit',{key:distinct?`bounded:${i%1000}`:'shared',limit:10,windowMs:1000});
      return {status:r.allowed?200:429};
    },c.opts.concurrency);
  },
  async bus(c){
    if(c.opts.replicas!==2) throw new Error('Bus scenario requires MULTI');
    const before=await c.children[0].rpc('busState');
    await c.stage('bus-wakeups',()=>c.children[1].rpc('bus',{perfSentAt:Date.now(),perfSentMono:mono(),envelope:{eventId:c.key(),type:'PLAYER_SETTINGS_UPDATED',occurredAt:new Date().toISOString(),data:{}},recipients:{playerIds:[]}}).then(()=>({status:200})),1,c.opts.duration,50);
    await until(async()=>(await c.children[0].rpc('busState')).received>before.received);
    const state=await c.children[0].rpc('busState');
    await writeFile(`${c.root}/bus.json`,JSON.stringify({received:state.received-before.received,latency:c.histogram(state.latencies),tables:await c.query('SELECT count(*)::int rows, count(*) FILTER (WHERE expires_at<=now())::int expired FROM distributed_bus_events')},null,2));
    await c.query('SELECT pg_terminate_backend($1)',[state.pid]);
    await until(async()=>{const r=await c.children[0].rpc('busState');return r.connected&&r.pid!==state.pid;});
    await c.children[1].rpc('bus',{perfSentAt:Date.now(),perfSentMono:mono(),envelope:{eventId:c.key(),type:'PLAYER_SETTINGS_UPDATED',occurredAt:new Date().toISOString(),data:{}},recipients:{playerIds:[]}});
    await until(async()=>(await c.children[0].rpc('busState')).received>state.received);
  },
  async backlog(c){
    const result=[];
    for(const size of [0,5000]){
      if(size) {
        // Historical terminal rows, no pending physical effects. Same shape as
        // actual commands, INSERT through constraints; no production data.
        await c.query(`INSERT INTO game_commands(id,game_server_id,type,payload,idempotency_key,idempotency_scope,actor_type,requested_by_system_source,
          correlation_id,status,created_at,completed_at)
          SELECT gen_random_uuid(),$1,'BRIDGE_PING','{"nonce":"perf"}','dataset:'||n,'SYSTEM:AGENT','SYSTEM','AGENT',
          gen_random_uuid(),'FAILED',now()-interval '1 day',now()-interval '1 day' FROM generate_series(1,$2) n`,[c.servers[1].id,size]);
        c.historicalFailures=size;
        await c.query('ANALYZE game_commands');
      }
      const times=[];for(let i=0;i<20;i++)times.push(await c.children[0].rpc('collect'));
      const explain=times.some(t=>t>100)?await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT status,count(*),min(created_at) FROM game_commands WHERE status IN ('PENDING','DISPATCHED','ACKNOWLEDGED') GROUP BY status`):null;
      result.push({historicalRows:size,latency:c.histogram(times),explain});
    }
    await writeFile(`${c.root}/backlog.json`,JSON.stringify(result,null,2));
  },
  async mixed(c){
    // 12.6B: sustained mixed load, not per-subsystem maximum. Every request
    // and work item is logged with a monotonic timestamp for windowed series.
    await vipOffer(c);
    const log=[];const record=(kind,t,status,ms)=>{if(log.length<2000000)log.push([kind,Math.round(t),status,Math.round(ms*100)/100]);};
    const timed=async(kind,fn)=>{const t=mono();try{const r=await fn();record(kind,t,r?.status??200,mono()-t);return r;}
      catch(e){record(kind,t,'error',mono()-t);throw e;}};
    // Player realtime on A and B, Staff realtime on A (bounded, long-lived).
    // The server closes a socket when its JWT expires (by design): long-lived
    // sockets are reopened with the refreshed tokens, as a real client would.
    let live=[];let seen=0,staffSeen=0,liveReopened=0;
    const openLive=async()=>{const previous=live;live=[];
      for(const [i,surface,port] of [[0,'PLAYER',0],[1,'PLAYER',c.opts.replicas-1],[2,'STAFF',0]]){
        const s=new Socket(c.replicas[port].port,'realtime',700+i);c.sockets.push(s);live.push(s);
        await s.auth(surface,surface==='STAFF'?c.staff.accessToken:c.players[i].accessToken);
        s.listeners.add(f=>{if(f.type==='PLAYER_SETTINGS_UPDATED')seen++;if(f.type?.startsWith('STAFF_')||f.type?.startsWith('SERVER_CONTROL')||f.type?.startsWith('GAME_'))staffSeen++;});
      }
      for(const s of previous)await s.close();};
    await openLive();
    const started=mono(),until_=started+c.opts.duration*1000,active=()=>mono()<until_&&!c.stopped;
    const counters={commands:0,controls:0,trades:0,markets:0,grants:0,chats:0,chat429:0,syncs:0,refresh:0,churn:0,limiter:0,limiter429:0,bus:0,settings:0};
    const reads=['dashboard','player/game-servers','player/me/characters','operations/domain-event-receipts?limit=50','player/me'];
    // Lane failures are counted (and reported) instead of aborting a long soak.
    const laneErrors={};
    const loop=async(name,periodMs,body)=>{let i=0;while(active()){const t=mono();
      try{await body(i++);}catch(e){const row=laneErrors[name]??={count:0,first:[]};row.count++;if(row.first.length<3)row.first.push(e.message);}
      const wait=periodMs-(mono()-t);if(wait>0&&active())await pause(Math.min(wait,until_-mono()));}};
    const lanes=[
      // Two GameCommand lanes (HTTP in B, Agent in A), each waits the RESULT.
      ...[0,1].map(k=>loop(`command-${k}`,300,async i=>{await timed('gamecommand',()=>gameCommand(c,k+2*i));counters.commands++;})),
      loop('work-sync',1000,async()=>{await timed('work-sync',()=>c.agents[0].sync().then(r=>({status:r.type==='WORK_ITEMS'?200:500})));counters.syncs++;}),
      loop('settings',1000,async i=>{await timed('settings',()=>c.http.call('player/settings',{method:'PATCH',token:c.players[0].accessToken,node:node(c),key:c.key(),body:{locale:i%2?'pt-BR':'en-US'}}));counters.settings++;}),
      loop('economy',12000,async i=>{await timed('trade',async()=>{await trade(c);return {status:200};});counters.trades++;
        await timed('market',async()=>{await market(c,i%2===0);return {status:200};});counters.markets++;
        await timed('vip',async()=>{await grant(c);return {status:200};});counters.grants++;}),
      loop('control',20000,async i=>{await timed('server-control',()=>control(c,i));counters.controls++;}),
      loop('chat',2500,async i=>{const p=c.parties[i%c.parties.length];
        const r=await timed('chat',()=>c.http.call('player/chat/global',{method:'POST',token:p.session.accessToken,identity:p.identity,node:i%c.opts.replicas,key:c.key(),body:{characterLinkId:p.link,message:`soak ${i}`}}));
        if(r.status===429)counters.chat429++;else counters.chats++;}),
      // Access tokens live 15 min: every session in use is refreshed every
      // 4 min from its own client address (legitimate, moderate refresh).
      loop('refresh',Number(process.env.PERF_REFRESH_MS??240000),async i=>{if(!i)return;for(const [surface,s,identity] of [['',c.staff,750],...c.players.map((p,k)=>['player/',p,100+k])]){
        const r=await timed('refresh',()=>c.http.call(`${surface}auth/refresh`,{method:'POST',body:{refreshToken:s.refreshToken},identity,node:node(c)}));
        if(r.status===200){Object.assign(s,r.body);counters.refresh++;}else counters.refreshFailed=(counters.refreshFailed??0)+1;}
        await openLive();liveReopened++;}),
      loop('churn',5000,async i=>{await timed('realtime-churn',async()=>{const s=new Socket(c.replicas[i%c.opts.replicas].port,'realtime',751+(i%4));
        await s.auth('PLAYER',c.players[4+(i%4)].accessToken);await s.close();return {status:200};});counters.churn++;}),
      loop('limiter',200,async i=>{const r=await timed('limiter',()=>c.children[i%2].rpc('limit',{key:`soak:${i%200}`,limit:10,windowMs:10000}).then(r=>({status:r.allowed?200:429})));
        counters.limiter++;if(r.status===429)counters.limiter429++;}),
      loop('staff-fanout',1000,async()=>{await timed('staff-publish',()=>c.children[node(c)].rpc('publish',{type:'STAFF_OPERATIONS_UPDATED',data:{sentAt:Date.now(),sentMono:mono()},recipients:{staffPermission:'OPERATIONS_READ'}}).then(()=>({status:200})));counters.bus++;}),
    ];
    const work=Promise.all(lanes);
    const http=await c.stage('mixed-http',(lane,i)=>{const url=reads[i%reads.length];
      return timed('read',()=>c.http.call(url,{token:url.startsWith('player')?c.players[0].accessToken:c.staff.accessToken,node:lane%c.opts.replicas}));},c.opts.concurrency,c.opts.duration,20);
    await work;
    assert.ok(seen>0);await until(async()=>!(await c.query("SELECT count(*)::int n FROM vip_reward_deliveries WHERE status IN ('PENDING','COMMAND_CREATED')"))[0].n,45000);
    for(const s of live)await s.close();
    await commandTimings(c);await controlTimings(c);
    // Windowed series (10 s): accepted throughput, 429, 5xx and percentiles per kind.
    const windows=new Map();
    for(const [kind,t,status,ms] of log){const w=Math.floor((t-started)/10000);const key=`${w}|${kind}`;
      const row=windows.get(key)??{window:w,kind,count:0,ok:0,r429:0,r5xx:0,errors:0,lat:[]};row.count++;
      if(status==='error')row.errors++;else if(status>=200&&status<300)row.ok++;else if(status===429)row.r429++;else if(status>=500)row.r5xx++;
      row.lat.push(ms);windows.set(key,row);}
    const series=[...windows.values()].map(({lat,...r})=>({...r,okPerSecond:r.ok/10,...c.histogram(lat)}));
    const byKind={};for(const [kind,,status,ms] of log){const k=byKind[kind]??={count:0,ok:0,r429:0,r5xx:0,errors:0,lat:[]};k.count++;
      if(status==='error')k.errors++;else if(status>=200&&status<300)k.ok++;else if(status===429)k.r429++;else if(status>=500)k.r5xx++;k.lat.push(ms);}
    const seconds=(mono()-started)/1000;
    const totals=Object.fromEntries(Object.entries(byKind).map(([k,{lat,...r}])=>[k,{...r,okPerSecond:r.ok/c.opts.duration,...c.histogram(lat)}]));
    await writeFile(`${c.root}/mixed-series.json`,JSON.stringify(series));
    await writeFile(`${c.root}/mixed.json`,JSON.stringify({realDurationSeconds:seconds,workloadSeconds:c.opts.duration,counters,laneErrors,liveReopened,realtimeEvents:seen,staffEvents:staffSeen,httpStage:{throughput:http.throughput,useful:http.usefulThroughput,latency:http.successLatencyMs,statuses:http.statuses},totals},null,2));
  }
};
