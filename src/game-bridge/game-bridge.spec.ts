import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { gameFixture } from '../../test/support/game-bridge-unit-fixture.js';
import { CommandStatus as S } from './command-state.js';
import { DisconnectedGameGateway } from './game-gateway.js';

describe('Game Bridge services', () => {
  let f: ReturnType<typeof gameFixture>;
  beforeEach(() => {
    f = gameFixture();
  });
  it('returns identical idempotent commands and rejects conflicting payloads', async () => {
    const input = {
      gameServerId: f.server.id,
      type: 'BRIDGE_PING' as const,
      payload: { nonce: 'ping' },
      idempotencyKey: 'key',
    };
    expect((await f.bus.submit(input)).id).toBe(f.command.id);
    await expect(
      f.bus.submit({ ...input, payload: { nonce: 'other' } }),
    ).rejects.toThrow('Idempotency');
    expect(f.rows.GameCommand).toHaveLength(1);
  });
  it('defaults to an explicitly unavailable production gateway', async () => {
    expect(await new DisconnectedGameGateway().send()).toEqual({
      accepted: false,
      reason: 'UNAVAILABLE',
    });
  });
  it('does not imply ACK on accepted dispatch', async () => {
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    expect(f.command.acknowledgedAt).toBeNull();
    expect(f.results()).toHaveLength(0);
    expect(f.gateway.sends).toHaveLength(1);
  });
  it('keeps definite unavailable transport pending then fails at the limit', async () => {
    f.gateway.available = false;
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.PENDING);
    f.clock.advance(5000);
    await f.dispatcher.dispatch(f.command.id);
    f.clock.advance(5000);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.FAILED);
    expect(f.results()[0].errorCode).toBe('GATEWAY_UNAVAILABLE');
  });
  it('preserves uncertain delivery and never stores adapter exceptions', async () => {
    f.gateway.responses = [new Error('secret stack')];
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    await f.receiver.result(f.success());
    expect(f.command.status).toBe(S.SUCCEEDED);
    expect(JSON.stringify(f.results())).not.toContain('secret');
  });
  it('bounds a stalled adapter, aborts it and permits the same logical retry', async () => {
    jest.useFakeTimers();
    try {
      f.gateway.beforeSend = () => new Promise<void>(() => {});
      const pending = f.dispatcher.dispatch(f.command.id);
      await jest.advanceTimersByTimeAsync(1000);
      expect((await pending).status).toBe(S.DISPATCHED);
      expect(f.command.dispatchAttempts).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
  it('records permanent refusal as FAILED', async () => {
    f.gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.FAILED);
    expect(f.results()[0].errorCode).toBe('DISPATCH_REJECTED');
  });
  it('accepts ACK idempotently', async () => {
    await f.dispatcher.dispatch(f.command.id);
    await f.receiver.acknowledge(f.ack());
    const first = f.command.acknowledgedAt;
    f.clock.advance(1);
    await f.receiver.acknowledge(f.ack());
    expect(f.command.acknowledgedAt).toBe(first);
    expect(f.command.status).toBe(S.ACKNOWLEDGED);
  });
  it('records success and identical duplicates once', async () => {
    await f.dispatcher.dispatch(f.command.id);
    await f.receiver.acknowledge(f.ack());
    await f.receiver.result(f.success());
    await f.receiver.result(f.success());
    expect(f.command.status).toBe(S.SUCCEEDED);
    expect(f.results()).toHaveLength(1);
  });
  it('infers ACK for a result before ACK and ignores later ACK', async () => {
    await f.dispatcher.dispatch(f.command.id);
    await f.receiver.result(f.success());
    const completed = f.command.completedAt;
    await f.receiver.acknowledge(f.ack());
    expect(f.command.status).toBe(S.SUCCEEDED);
    expect(f.command.completedAt).toBe(completed);
  });
  it('records failure with a local bounded message and rejects conflicting success', async () => {
    await f.dispatcher.dispatch(f.command.id);
    await f.receiver.result({
      ...f.ack(),
      outcome: S.FAILED,
      errorCode: 'PING_REJECTED',
    });
    await expect(f.receiver.result(f.success())).rejects.toThrow(
      'another result',
    );
    expect(f.results()[0]).toMatchObject({
      outcome: S.FAILED,
      errorMessage: 'Bridge rejected ping',
      result: null,
    });
  });
  it.each(['correlationId', 'connectionId', 'serverId'] as const)(
    'rejects wrong %s',
    async (field) => {
      await f.dispatcher.dispatch(f.command.id);
      await expect(
        f.receiver.acknowledge({ ...f.ack(), [field]: randomUUID() }),
      ).rejects.toThrow('does not match');
      // RESULT is bound to the command, not to the attempt's connection: an
      // unknown connection is refused because it is not the server's
      // current session.
      await expect(
        f.receiver.result({ ...f.success(), [field]: randomUUID() }),
      ).rejects.toThrow(
        field === 'connectionId' ? 'no longer active' : 'does not match',
      );
    },
  );
  it('retries ACK timeout without reverting status or extending execution', async () => {
    await f.dispatcher.dispatch(f.command.id);
    const deadline = f.command.executionDeadlineAt;
    f.clock.advance(4999);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.gateway.sends).toHaveLength(1);
    f.clock.advance(1);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    expect(f.command.dispatchAttempts).toBe(2);
    expect(f.command.executionDeadlineAt).toEqual(deadline);
    expect(f.gateway.sends[1].envelope.commandId).toBe(
      f.gateway.sends[0].envelope.commandId,
    );
    expect(f.gateway.sends[1].envelope.correlationId).toBe(
      f.gateway.sends[0].envelope.correlationId,
    );
  });
  it('waits final ACK then expires after max attempts', async () => {
    for (let i = 0; i < 3; i++) {
      await f.dispatcher.dispatch(f.command.id);
      f.clock.advance(5000);
    }
    expect(f.command.status).toBe(S.DISPATCHED);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.TIMEOUT);
    expect(f.command.dispatchAttempts).toBe(3);
  });
  it('expires execution inside the receiver without requiring a scheduler', async () => {
    await f.dispatcher.dispatch(f.command.id);
    await f.receiver.acknowledge(f.ack());
    f.clock.advance(30000);
    await f.receiver.result(f.success());
    expect(f.command.status).toBe(S.TIMEOUT);
    await expect(f.receiver.result(f.success())).rejects.toThrow(
      'another result',
    );
    expect(f.results()).toHaveLength(1);
  });
  it('updates heartbeat and rejects stale heartbeat', async () => {
    f.clock.advance(1000);
    expect(await f.connections.heartbeat(f.server.id, f.connection.id)).toBe(
      true,
    );
    expect(f.connection.lastHeartbeatAt).toEqual(f.clock.now());
    f.clock.advance(120000);
    expect(await f.connections.isConnectionHealthy(f.server.id)).toBe(false);
    expect(await f.connections.heartbeat(f.server.id, f.connection.id)).toBe(
      false,
    );
    expect(f.connection.disconnectReason).toBe('STALE');
  });
  it('supersedes connection and refuses heartbeat resurrection', async () => {
    const next = await f.connections.connect({
      gameServerId: f.server.id,
      externalConnectionId: 'new',
    });
    expect(next.id).not.toBe(f.connection.id);
    expect(f.connection.disconnectReason).toBe('SUPERSEDED');
    expect(await f.connections.heartbeat(f.server.id, f.connection.id)).toBe(
      false,
    );
    await expect(
      f.connections.connect({
        gameServerId: f.server.id,
        externalConnectionId: f.connection.externalConnectionId,
      }),
    ).rejects.toThrow('cannot be reused');
  });
  it('keeps an uncertain first delivery DISPATCHED after permanent retry refusal, then times out', async () => {
    f.gateway.responses = [
      new Error('unknown delivery'),
      { accepted: false, reason: 'PERMANENT' },
    ];
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    f.clock.advance(5000);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    expect(f.results()).toHaveLength(0);
    f.clock.advance(25000);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.TIMEOUT);
  });
  it('accepts a result after a permanently refused retry before timeout', async () => {
    f.gateway.responses = [
      new Error('unknown delivery'),
      { accepted: false, reason: 'PERMANENT' },
    ];
    await f.dispatcher.dispatch(f.command.id);
    f.clock.advance(5000);
    await f.dispatcher.dispatch(f.command.id);
    await f.receiver.result(f.success());
    expect(f.command.status).toBe(S.SUCCEEDED);
  });
  it('never infers FAILED from server disable after possible delivery', async () => {
    await f.dispatcher.dispatch(f.command.id);
    f.server.enabled = false;
    f.clock.advance(5000);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    await f.receiver.result(f.success());
    expect(f.command.status).toBe(S.SUCCEEDED);
  });
  it('handles RESULT during send and fences the subsequent transport refusal', async () => {
    f.gateway.beforeSend = async () => {
      await f.receiver.result(f.success());
    };
    f.gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.SUCCEEDED);
    expect(f.results()).toHaveLength(1);
    expect(f.command.dispatchLeaseId).toBeNull();
  });
  it('recovers abandoned claims conservatively as possibly delivered', async () => {
    f.command.dispatchLeaseId = randomUUID();
    f.command.dispatchLeaseExpiresAt = f.clock.now();
    f.command.dispatchedConnectionId = f.connection.id;
    f.command.dispatchAttempts = 1;
    f.command.executionDeadlineAt = new Date(f.clock.now().getTime() + 30000);
    f.gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.DISPATCHED);
    f.clock.advance(30000);
    await f.dispatcher.dispatch(f.command.id);
    expect(f.command.status).toBe(S.TIMEOUT);
  });
});
