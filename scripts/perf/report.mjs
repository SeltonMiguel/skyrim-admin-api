// Small, reviewable summaries from raw JSONL; no raw metrics are committed.
import { readFile } from 'node:fs/promises';
const root=process.argv[2];if(!root)throw new Error('Usage: node scripts/perf/report.mjs OUTPUT_DIR');
const stages=JSON.parse(await readFile(`${root}/stages.json`,'utf8'));
const samples=(await readFile(`${root}/samples.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
const metric=(text,suffix)=>Number(text.split('\n').find(l=>l.startsWith(`skyrim_admin_${suffix} `))?.split(' ').at(-1)??0);
console.log('| Scenario | C | accepted/s | p50 ms | p95 ms | p99 ms | 4xx | 5xx/transport | app CPU cores | PG CPU cores | generator CPU cores | pool waiting max | lag p99 max ms |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for(const s of stages){
 const rows=samples.filter(r=>s.startedMono!==undefined&&r.mono!==undefined&&r.mono>=s.startedMono&&r.mono<=s.endedMono);
 const first=rows[0],last=rows.at(-1),seconds=first&&last?(last.mono-first.mono)/1000:0;
 const cpu=s.appCpuCores??(seconds?last.nodes.reduce((n,r,i)=>n+(r.cpu.user+r.cpu.system-first.nodes[i].cpu.user-first.nodes[i].cpu.system)/1e6/seconds,0):null);
 const pg=seconds&&last.postgresResource&&first.postgresResource?(last.postgresResource.cpuUsec-first.postgresResource.cpuUsec)/1e6/seconds:null;
 const generator=seconds?(last.generator.cpu.user+last.generator.cpu.system-first.generator.cpu.user-first.generator.cpu.system)/1e6/seconds:null;
 console.log(`| ${s.name} | ${s.concurrency} | ${s.usefulThroughput.toFixed(1)} | ${s.successLatencyMs.p50.toFixed(2)} | ${s.successLatencyMs.p95.toFixed(2)} | ${s.successLatencyMs.p99.toFixed(2)} | ${s.expected4xx} | ${s.errors} | ${cpu===null?'n/a':cpu.toFixed(2)} | ${pg===null?'n/a':pg.toFixed(2)} | ${generator===null?'n/a':generator.toFixed(2)} | ${s.maxPoolWaiting} | ${(s.maxEventLoopLag*1000).toFixed(1)} |`);
}
const last=samples.at(-1);
console.log(JSON.stringify({samples:samples.length,cooldown:last.tables,
 memory:last.nodes.map(n=>n.memory),resources:last.nodes.map(n=>n.resources),
 workerErrors:last.metrics.map(m=>m.split('\n').filter(l=>l.startsWith('skyrim_admin_worker_ticks_total')&&l.includes('outcome="error"'))),
 busErrors:last.metrics.map(m=>metric(m,'cluster_bus_errors_total')),rateLimitErrors:last.metrics.map(m=>metric(m,'rate_limit_backend_errors_total'))},null,2));
