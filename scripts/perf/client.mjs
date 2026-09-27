import { monotonicMs } from './clock.mjs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, timeout = 15000) {
  const end = monotonicMs() + timeout;
  for (;;) { const value = await check(); if (value) return value;
    if (monotonicMs() >= end) throw new Error('Performance state deadline exceeded'); await pause(20); }
}
export class Http {
  constructor(ports) { this.ports = ports; this.agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 16 }); }
  call(path, { method = 'GET', body, token, node = 0, identity = 1, key } = {}) {
    const start = monotonicMs();
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ hostname: '127.0.0.1', port: this.ports[node], path: `/api/v1/${path}`,
        method, agent: this.agent, localAddress: `127.0.${Math.floor(identity / 250)}.${identity % 250 + 1}`,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}) } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
        res.on('end', () => { let body; try { body = JSON.parse(text); } catch { body = text; }
          resolve({ status: res.statusCode, body, ms: monotonicMs() - start, bytes: Buffer.byteLength(text) }); });
      });
      req.setTimeout(15000, () => req.destroy(new Error('HTTP deadline')));
      req.on('error', reject); req.end(data);
    });
  }
  async ok(path, options, status = 200) {
    const r = await this.call(path, options);
    if (r.status !== status) throw new Error(`${path}: expected ${status}, got ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
  close() { this.agent.destroy(); }
}
export class Socket {
  constructor(port, path, identity = 1) {
    this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/${path}`, { localAddress: `127.0.${Math.floor(identity / 250)}.${identity % 250 + 1}` });
    this.opened = new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    // Keep cancellation-before-open from becoming an unhandled rejection.
    this.opened.catch(() => {});
    this.ws.on('error', () => {});
    this.ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() };
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`Socket closed ${code}: ${reason}`)); }
      this.pending.clear(); });
    this.ws.on('message', raw => {
      const frame = JSON.parse(raw); const key = this.pending.has(frame.payload?.inReplyTo) ? frame.payload.inReplyTo : frame.type;
      const waiter = this.pending.get(key);
      if (waiter) { this.pending.delete(key); clearTimeout(waiter.timer); waiter.resolve(frame); }
      for (const listener of this.listeners) listener(frame);
    });
  }
  wait(key, timeout = 15000) {
    if (this.closed) return Promise.reject(new Error(`Socket closed: ${JSON.stringify(this.closed)}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error(`Socket timeout ${key}`)); }, timeout);
      this.pending.set(key, { resolve, reject, timer });
    });
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  async auth(surface, token) {
    await this.opened; const ready = this.wait('AUTHENTICATED'); this.send({ type: 'AUTH', surface, token }); return ready;
  }
  async close() {
    if (this.closed) return;
    const closed = new Promise(resolve => this.ws.once('close', resolve)); this.ws.close();
    const timer = setTimeout(() => this.ws.terminate(), 1000); await closed; clearTimeout(timer);
  }
}
export class Agent extends Socket {
  constructor(port, serverId, identity, latency = 0) {
    super(port, 'agent', identity); this.serverId = serverId; this.latency = latency;
    this.commands = new Map(); this.controls = new Map(); this.errors = []; this.maxActive = 0; this.active = 0;
    // 12.6B: the Agent's own civil clock (offset from the host), used only to
    // interpret notAfter, as a real Agent would with its own clock.
    this.clockOffsetMs = 0;
    this.listeners.add(f => { if (f.type === 'COMMAND' || f.type === 'SERVER_CONTROL')
      void this.execute(f).catch(e => this.errors.push(e.message)); });
  }
  frame(type, payload) { return { protocolVersion: '1', type, messageId: randomUUID(), gameServerId: this.serverId,
    occurredAt: new Date().toISOString(), payload }; }
  request(type, payload) { const f = this.frame(type, payload); const answer = this.wait(f.messageId); this.send(f); return answer; }
  async hello(key) {
    await this.opened; const ready = this.wait('AUTHENTICATED');
    this.send(this.frame('HELLO', { credentialId:key.credentialId, credentialSecret:key.credentialSecret, agentVersion: '1.0.0',
      capabilities: ['GAME_COMMAND_V1', 'COMMAND_DEDUP_V1', 'BRIDGE_PING', 'CHARACTER_INVENTORY_QUERY',
        'CHARACTER_ITEM_GIVE', 'CHARACTER_TITLE_GIVE', 'SERVER_CONTROL_V1', 'SERVER_START', 'SERVER_PAUSE', 'SERVER_RESTART'],
      gameProcessState: 'RUNNING', skseReady: true }));
    this.connectionId = (await ready).payload.connectionId;
    this.timer = setInterval(() => { void this.request('HEARTBEAT', { gameProcessState: 'RUNNING', skseReady: true })
      .catch(e => this.errors.push(e.message)); }, 10000);
  }
  async execute(f) {
    const p = f.payload; const control = f.type === 'SERVER_CONTROL'; const id = control ? p.operationId : p.commandId;
    const journal = control ? this.controls : this.commands;
    let entry = journal.get(id);
    if (entry) {
      if (entry.payload.correlationId!==p.correlationId || JSON.stringify(entry.payload.payload)!==JSON.stringify(p.payload))
        throw new Error('Retry identity/payload changed');
      entry.frames++;
    } else {
      entry = { receivedAt: Date.now(), receivedMono:monotonicMs(), frames: 1, effects: 0, attempts: [], attemptsMono: [], payload: p };
      journal.set(id, entry);
    }
    entry.attemptsMono.push(monotonicMs());
    if (!control) entry.attempts.push(p.attempt);
    this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.latency) await pause(this.latency);
      if (control) {
        if (!entry.outcome) { entry.agentRemainingMs = Date.parse(p.notAfter) - (Date.now() + this.clockOffsetMs);
          entry.effects = entry.agentRemainingMs >= 0 ? 1 : 0;
          entry.outcome = entry.effects ? { outcome: 'SUCCEEDED' } : { outcome: 'FAILED', errorCode: 'DELIVERY_EXPIRED' }; }
        const r = await this.request('SERVER_CONTROL_RESULT', { operationId: id, correlationId: p.correlationId, type: p.type, ...entry.outcome });
        entry.reply = r.payload;
      } else {
        entry.ackEmittedMono=monotonicMs(); entry.ackEmittedAt=Date.now();
        this.send(this.frame('COMMAND_ACK', { commandId: id, correlationId: p.correlationId, attempt: p.attempt }));
        if (!entry.result) {
          entry.effects++;
          const input = p.payload;
          entry.result = p.type === 'BRIDGE_PING' ? { nonce: input.nonce } : p.type === 'CHARACTER_INVENTORY_QUERY'
            ? { characterId: input.characterId, items: [] }
            : { characterId: input.characterId, applied: true, targetId: input.itemId ?? input.titleId };
        }
        const r = await this.request('COMMAND_RESULT', { commandId: id, correlationId: p.correlationId, outcome: 'SUCCEEDED', result: entry.result });
        entry.reply = r.payload;
      }
      entry.completedAt = Date.now(); entry.completedMono=monotonicMs();
    } finally { this.active--; }
  }
  event(kind, data, eventId = randomUUID()) { return this.request('DOMAIN_EVENT', { kind, data, eventId }); }
  sync(body = {}) { return this.request('WORK_SYNC', body); }
  async close() { clearInterval(this.timer); await super.close(); }
}
