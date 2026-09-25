import { randomUUID } from 'node:crypto';
import { RoleName as R } from '../rbac/roles.js';
import {
  actor,
  ActorType,
  idempotencyScope,
  playerActor,
  STAFF_IDEMPOTENCY_SCOPE,
  staffActor,
  systemActor,
  SystemSource,
} from './actor.contracts.js';
import { auditActor } from '../audit/audit.service.js';

const staff = {
  id: randomUUID(),
  username: 'coordinator',
  displayName: 'Coordinator',
  roleName: R.COORDINATOR,
};

describe('Actor contract', () => {
  it('defines a closed discriminated union and system allowlist', () => {
    expect(Object.values(ActorType)).toEqual(['STAFF', 'PLAYER', 'SYSTEM']);
    expect(Object.values(SystemSource)).toEqual([
      'AGENT',
      'PROFESSION',
      'VIP_DELIVERY',
    ]);
  });
  it('builds valid STAFF, PLAYER and SYSTEM actors as detached copies', () => {
    const input = { ...staff, passwordHash: 'secret', permissions: ['X'] };
    const built = staffActor(input);
    expect(built).toEqual({ type: ActorType.STAFF, ...staff });
    expect(built).not.toHaveProperty('passwordHash');
    expect(built).not.toHaveProperty('permissions');
    const id = randomUUID();
    expect(playerActor(id.toUpperCase())).toEqual({
      type: ActorType.PLAYER,
      playerId: id,
    });
    expect(systemActor(SystemSource.PROFESSION)).toEqual({
      type: ActorType.SYSTEM,
      source: SystemSource.PROFESSION,
    });
    const source = { type: ActorType.PLAYER, playerId: id };
    const copy = actor(source);
    source.playerId = randomUUID();
    expect(copy).toEqual({ type: ActorType.PLAYER, playerId: id });
  });
  it('rejects invalid combinations and unknown shapes', () => {
    const id = randomUUID();
    for (const value of [
      null,
      'STAFF',
      {},
      { type: 'ADMIN', id },
      { type: ActorType.PLAYER },
      { type: ActorType.PLAYER, playerId: 'player-1' },
      { type: ActorType.PLAYER, playerId: id, roleName: R.COORDINATOR },
      { type: ActorType.PLAYER, playerId: id, permissions: [] },
      { type: ActorType.PLAYER, playerId: id, source: SystemSource.AGENT },
      { type: ActorType.SYSTEM, source: 'SHELL' },
      { type: ActorType.SYSTEM, source: SystemSource.AGENT, playerId: id },
      { type: ActorType.STAFF, ...staff, permissions: [] },
      { type: ActorType.STAFF, playerId: id },
    ])
      expect(() => actor(value)).toThrow('Invalid actor');
    expect(() => playerActor('')).toThrow();
    expect(() => systemActor('RAW' as SystemSource)).toThrow();
  });
  it('isolates idempotency scopes by player and system source, sharing STAFF', () => {
    const a = randomUUID(),
      b = randomUUID();
    expect(idempotencyScope(staffActor(staff))).toBe(STAFF_IDEMPOTENCY_SCOPE);
    expect(idempotencyScope(staffActor({ ...staff, id: randomUUID() }))).toBe(
      'STAFF',
    );
    expect(idempotencyScope(playerActor(a))).toBe(`PLAYER:${a}`);
    expect(idempotencyScope(playerActor(a))).not.toBe(
      idempotencyScope(playerActor(b)),
    );
    expect(idempotencyScope(systemActor(SystemSource.AGENT))).toBe(
      'SYSTEM:AGENT',
    );
    expect(idempotencyScope(systemActor(SystemSource.PROFESSION))).not.toBe(
      idempotencyScope(systemActor(SystemSource.VIP_DELIVERY)),
    );
  });
  it('treats untyped Audit snapshots as STAFF and never lends a role to PLAYER/SYSTEM', () => {
    expect(auditActor(staff)).toEqual({ type: ActorType.STAFF, ...staff });
    expect(auditActor(undefined)).toBeUndefined();
    const player = auditActor(playerActor(randomUUID()));
    expect(player).not.toHaveProperty('roleName');
    expect(auditActor(systemActor(SystemSource.AGENT))).toEqual({
      type: ActorType.SYSTEM,
      source: SystemSource.AGENT,
    });
  });
});
