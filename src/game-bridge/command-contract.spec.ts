import { randomUUID } from 'node:crypto';
import {
  commandPayload,
  envelope,
  pingData,
  sameCommand,
} from './command-contract.js';
import type {
  CommandType,
  CommandMap,
  SubmitCommand,
} from './command-contract.js';
import {
  COMMAND_TRANSITIONS,
  CommandStatus as S,
  isTerminal,
  transition,
} from './command-state.js';
import { GameCommand } from './entities/game-command.entity.js';

// Typechecked with the tests; unsupported commands/results are not part of the API.
const typed: SubmitCommand = {
  gameServerId: randomUUID(),
  type: 'BRIDGE_PING',
  payload: { nonce: 'ping' },
  idempotencyKey: 'key',
};
const typedResult: CommandMap['BRIDGE_PING']['result'] = {
  nonce: typed.payload.nonce,
};
// @ts-expect-error arbitrary commands are not allowed
const unsupported: CommandType = 'CONSOLE';
void unsupported;

describe('Game command contracts and state machine', () => {
  it.each(
    Object.entries(COMMAND_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => [from as S, to]),
    ),
  )('allows %s -> %s', (from, to) => {
    const command = { status: from };
    transition(command, to);
    expect(command.status).toBe(to);
  });
  it.each([S.SUCCEEDED, S.FAILED, S.TIMEOUT])(
    'makes %s terminal with no outgoing transition',
    (status) => {
      expect(isTerminal(status)).toBe(true);
      for (const next of Object.values(S))
        expect(() => transition({ status }, next)).toThrow(
          'Invalid command transition',
        );
    },
  );
  it('rejects backward transitions, local DISPATCHED failure and skipping ACK', () => {
    expect(() => transition({ status: S.DISPATCHED }, S.FAILED)).toThrow();
    expect(() => transition({ status: S.DISPATCHED }, S.PENDING)).toThrow();
    expect(() => transition({ status: S.PENDING }, S.SUCCEEDED)).toThrow();
    expect(() =>
      transition({ status: S.ACKNOWLEDGED }, S.DISPATCHED),
    ).toThrow();
  });
  it('supports typed ping payload/result and snapshots data', () => {
    const input = { nonce: 'ping' };
    const payload = commandPayload('BRIDGE_PING', input);
    input.nonce = 'changed';
    expect(payload).toEqual(typedResult);
  });
  it.each([
    null,
    [],
    {},
    { nonce: 1 },
    { nonce: 'ping', console: 'execute' },
    { nonce: '' },
    { nonce: 'x'.repeat(129) },
    { nonce: 'x'.repeat(1048576) },
    { nonce: 'line\ncommand' },
  ])('rejects invalid or excessive data %#', (input) => {
    expect(() => pingData(input)).toThrow();
  });
  it('rejects getters and never executes them', () => {
    expect(() =>
      pingData({
        get nonce() {
          throw new Error('must never run');
        },
      }),
    ).toThrow('Invalid BRIDGE_PING');
  });
  it('rejects arbitrary types at runtime', () =>
    expect(() =>
      commandPayload('CONSOLE' as CommandType, { nonce: 'ping' }),
    ).toThrow('Unsupported'));
  it('compares idempotent and conflicting payloads', () => {
    const existing = {
      type: 'BRIDGE_PING' as const,
      payload: { nonce: 'ping' },
    };
    expect(sameCommand(existing, typed.type, typed.payload)).toBe(true);
    expect(sameCommand(existing, typed.type, { nonce: 'different' })).toBe(
      false,
    );
  });
  it('maps an explicit versioned envelope, excluding persistence/context fields', () => {
    const now = new Date('2026-09-19T14:00:00Z');
    const command = Object.assign(new GameCommand(), {
      id: randomUUID(),
      gameServerId: randomUUID(),
      correlationId: randomUUID(),
      dispatchedConnectionId: randomUUID(),
      type: 'BRIDGE_PING',
      payload: { nonce: 'ping' },
      idempotencyKey: 'key',
      createdAt: now,
      ackDeadlineAt: now,
      executionDeadlineAt: now,
      requestId: 'private-context',
    });
    expect(envelope(command)).toEqual({
      protocolVersion: '1',
      commandId: command.id,
      serverId: command.gameServerId,
      correlationId: command.correlationId,
      connectionId: command.dispatchedConnectionId,
      attempt: command.dispatchAttempts,
      idempotencyKey: 'key',
      type: 'BRIDGE_PING',
      payload: { nonce: 'ping' },
      issuedAt: now.toISOString(),
      ackDeadlineAt: now.toISOString(),
      executionDeadlineAt: now.toISOString(),
    });
  });
});
