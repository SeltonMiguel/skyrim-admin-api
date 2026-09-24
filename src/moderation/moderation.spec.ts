import { randomUUID } from 'node:crypto';
import { moderationCases } from '../../test/support/moderation-cases.js';
import {
  MODERATION_COMMAND_TYPES,
  moderationPayload,
  moderationResult,
} from './moderation-command.contracts.js';
import {
  commandPayload,
  commandResult,
  sameCommand,
  COMMAND_TYPES,
} from '../game-bridge/command-contract.js';
import type { SubmitCommand } from '../game-bridge/command-contract.js';
import { moderationText } from './moderation-validation.js';
import { MODERATION_POLICY } from './moderation-policy.js';
import { moderationAuditMetadata } from './moderation-audit.js';
import { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { commandDetail } from '../admin-queries/query.presenters.js';
import {
  moderationDetail,
  moderationReference,
} from './moderation-operation.presenter.js';
import { sanitizeMetadata } from '../audit/metadata-sanitizer.js';
import { CommandStatus as S } from '../game-bridge/command-state.js';

// @ts-expect-error explicit SET requires enabled
const missingState: SubmitCommand = {
  gameServerId: 's',
  type: 'PLAYER_GOD_MODE_SET',
  payload: { playerId: 'p' },
  idempotencyKey: 'k',
};
void missingState;
const cases = moderationCases(randomUUID());
describe('Moderation closed contracts', () => {
  it('adds exactly eight fixed commands to ping and the 17 Character commands', () => {
    expect(MODERATION_COMMAND_TYPES).toHaveLength(8);
    expect(COMMAND_TYPES).toHaveLength(32);
  });
  it.each(cases)(
    'validates payload, result, policy and redaction for $type',
    (sample) => {
      expect(commandPayload(sample.type, sample.payload)).toEqual(
        sample.payload,
      );
      expect(commandResult(sample.type, sample.result, sample.payload)).toEqual(
        sample.result,
      );
      expect(MODERATION_POLICY[sample.type]).toEqual({
        permission: sample.permission,
        auditAction: sample.action,
      });
      for (const extra of [
        { rawCommand: 'x' },
        { script: 'x' },
        { staffId: randomUUID() },
      ])
        expect(() =>
          moderationPayload(sample.type, { ...sample.payload, ...extra }),
        ).toThrow();
      for (const value of [
        { arbitrary: true },
        { ...sample.result, reason: 'private' },
        [],
        null,
      ])
        expect(() =>
          moderationResult(sample.type, value, sample.payload),
        ).toThrow();
      const command = Object.assign(new GameCommand(), {
        id: randomUUID(),
        gameServerId: randomUUID(),
        type: sample.type,
        payload: sample.payload,
        correlationId: randomUUID(),
        status: S.SUCCEEDED,
        idempotencyKey: 'secret-key',
        dispatchLeaseId: randomUUID(),
        dispatchedConnectionId: randomUUID(),
        result: Object.assign(new GameCommandResult(), {
          outcome: S.SUCCEEDED,
          result: sample.result,
          errorCode: null,
          errorMessage: null,
          receivedAt: new Date(),
        }),
      });
      expect(moderationDetail(command).result?.result).toEqual(sample.result);
      expect(moderationReference(command)).not.toHaveProperty('payload');
      const generic = JSON.stringify(commandDetail(command));
      expect(generic).not.toMatch(
        /playerId|actorStaffId|targetPlayerId|enabled|reason|message|opaque:|secret-key|dispatchLease|dispatchedConnection/,
      );
      const audit = moderationAuditMetadata(command);
      expect(sanitizeMetadata(audit)).toEqual(audit);
      expect(
        Object.keys(audit).every((key) =>
          [
            'gameServerId',
            'commandId',
            'correlationId',
            'playerId',
            'actorStaffId',
            'targetPlayerId',
            'enabled',
          ].includes(key),
        ),
      ).toBe(true);
      expect(JSON.stringify(audit)).not.toMatch(
        /private|payload|result|idempotency|lease|token/i,
      );
    },
  );
  it.each([true, false])(
    'validates explicit %s for all three state operations',
    (enabled) => {
      for (const sample of cases.filter((c) => 'enabled' in c.payload)) {
        const payload = { ...sample.payload, enabled };
        expect(
          moderationResult(sample.type, { ...sample.result, enabled }, payload),
        ).toEqual({ ...sample.result, enabled });
        expect(() =>
          moderationResult(
            sample.type,
            { ...sample.result, enabled: !enabled },
            payload,
          ),
        ).toThrow();
        for (const invalid of ['true', 'false', 0, 1, null, undefined])
          expect(() =>
            moderationPayload(sample.type, { ...payload, enabled: invalid }),
          ).toThrow();
      }
    },
  );
  it.each(cases)(
    'rejects mismatched success identity/state for $type',
    (sample) => {
      const result = { ...sample.result };
      const key = Object.keys(result)[0] as keyof typeof result;
      const invalid = {
        ...result,
        [key]: typeof result[key] === 'boolean' ? !result[key] : 'wrong-target',
      };
      expect(() =>
        moderationResult(sample.type, invalid, sample.payload),
      ).toThrow();
    },
  );
  it.each(['', ' ', 'x'.repeat(501), 'x\n', '\u0000', '\ud800', null, 1])(
    'rejects invalid text %#',
    (value) => {
      expect(() => moderationText(value)).toThrow();
      expect(() =>
        moderationPayload('PLAYER_BAN', { playerId: 'p', reason: value }),
      ).toThrow();
      expect(() =>
        moderationPayload('ANNOUNCEMENT_SEND', { message: value }),
      ).toThrow();
    },
  );
  it('normalizes literal text and opaque IDs for canonical retry without evaluation', () => {
    expect(moderationText(' x '.repeat(1))).toBe('x');
    expect(moderationText('x'.repeat(500))).toHaveLength(500);
    expect(moderationText('<hello>')).toBe('<hello>');
    expect(
      sameCommand(
        { type: 'PLAYER_BAN', payload: { playerId: 'p', reason: 'r' } },
        'PLAYER_BAN',
        { reason: ' r ', playerId: ' p ' },
      ),
    ).toBe(true);
    expect(() =>
      moderationPayload('PLAYER_BAN', {
        playerId: 'p',
        reason: 'x'.repeat(4096),
      }),
    ).toThrow();
    expect(() =>
      moderationResult(
        'ANNOUNCEMENT_SEND',
        { sent: true, extra: 'x'.repeat(65536) },
        { message: 'ok' },
      ),
    ).toThrow();
  });
  it('rejects hostile JSON and never invokes getters', () => {
    expect(() =>
      moderationPayload('ANNOUNCEMENT_SEND', {
        get message() {
          throw new Error('invoked');
        },
      }),
    ).toThrow('Invalid JSON');
    expect(() =>
      moderationPayload('ANNOUNCEMENT_SEND', {
        message: 'x',
        toJSON() {
          throw new Error('invoked');
        },
      }),
    ).toThrow('Invalid JSON');
  });
  it('rejects another domain in operation presentation', () => {
    expect(() =>
      moderationReference(
        Object.assign(new GameCommand(), { type: 'BRIDGE_PING' }),
      ),
    ).toThrow();
  });
});
