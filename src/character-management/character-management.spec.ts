import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CHARACTER_CASES } from '../../test/support/character-cases.js';
import {
  characterPayload,
  characterResult,
  CHARACTER_COMMAND_TYPES,
} from './character-command.contracts.js';
import type { CharacterCommandMap } from './character-command.contracts.js';
import {
  commandPayload,
  commandResult,
  sameCommand,
  MAX_COMMAND_PAYLOAD_BYTES,
  MAX_COMMAND_RESULT_BYTES,
} from '../game-bridge/command-contract.js';
import type {
  SubmitCommand,
  ResultMessage,
} from '../game-bridge/command-contract.js';
import { commandJson } from '../game-bridge/command-json.js';
import { externalId, quantity } from './character-validation.js';
import { CHARACTER_POLICY } from './character-policy.js';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions.js';
import { RoleName as R } from '../rbac/roles.js';
import { idempotencyKey } from './character.service.js';
import { characterAuditMetadata } from './character-audit.js';
import { sanitizeMetadata } from '../audit/metadata-sanitizer.js';
import { GameCommand } from '../game-bridge/entities/game-command.entity.js';
import { GameCommandResult } from '../game-bridge/entities/game-command-result.entity.js';
import { CommandStatus as S } from '../game-bridge/command-state.js';
import { commandDetail } from '../admin-queries/query.presenters.js';
import {
  operationReference,
  operationDetail,
} from './character-operation.presenter.js';
import { ItemBodyDto, CharacterQueryBodyDto } from './dto/character.dto.js';
import { gameFixture } from '../../test/support/game-bridge-unit-fixture.js';

// Compile-time contract regression checks (also checked by tsc --noEmit).
const typedResult: CharacterCommandMap['CHARACTER_INVENTORY_QUERY']['result'] =
  { characterId: 'c', items: [{ itemId: 'i', quantity: 1 }] };
void typedResult;
// @ts-expect-error item give requires itemId and quantity
const invalidPayload: SubmitCommand = {
  gameServerId: 's',
  type: 'CHARACTER_ITEM_GIVE',
  payload: { characterId: 'c' },
  idempotencyKey: 'key',
};
const arbitrary: SubmitCommand = {
  gameServerId: 's',
  // @ts-expect-error closed command type vocabulary
  type: 'CHARACTER_EXECUTE',
  payload: { characterId: 'c' },
  idempotencyKey: 'key',
};
const wrongResult: CharacterCommandMap['CHARACTER_INVENTORY_QUERY']['result'] =
  // @ts-expect-error query result does not accept mutation body
  { characterId: 'c', applied: true, targetId: 'i' };
void invalidPayload;
void arbitrary;
void wrongResult;

describe('Typed Character contracts and policies', () => {
  it.each(CHARACTER_CASES)(
    'validates payload/result and permission/action for $type',
    (sample) => {
      expect(characterPayload(sample.type, sample.payload)).toEqual(
        sample.payload,
      );
      expect(
        characterResult(sample.type, sample.result, sample.payload),
      ).toEqual(sample.result);
      expect(commandPayload(sample.type, sample.payload)).toEqual(
        sample.payload,
      );
      expect(commandResult(sample.type, sample.result, sample.payload)).toEqual(
        sample.result,
      );
      expect(CHARACTER_POLICY[sample.type]).toEqual({
        permission: sample.permission,
        auditAction: sample.action,
      });
      expect(() =>
        characterPayload(sample.type, {
          ...sample.payload,
          script: 'arbitrary',
        }),
      ).toThrow();
      expect(() =>
        characterResult(sample.type, { anything: [] }, sample.payload),
      ).toThrow();
      expect(() =>
        characterResult(
          sample.type,
          { ...sample.result, characterId: 'other' },
          sample.payload,
        ),
      ).toThrow('character mismatch');
      for (const role of [R.COORDINATOR, R.GENERAL_CHIEF])
        expect(ROLE_PERMISSIONS[role]).toContain(sample.permission);
      for (const role of [R.ADMIN, R.MODERATOR, R.SUPPORT, R.DEV])
        expect(ROLE_PERMISSIONS[role]).not.toContain(sample.permission);
    },
  );
  it('keeps 17 character types and BRIDGE_PING, without arbitrary command types', () => {
    expect(CHARACTER_COMMAND_TYPES).toHaveLength(17);
    expect(commandPayload('BRIDGE_PING', { nonce: 'ping' })).toEqual({
      nonce: 'ping',
    });
    expect(
      commandResult('BRIDGE_PING', { nonce: 'ping' }, { nonce: 'ping' }),
    ).toEqual({ nonce: 'ping' });
    expect(() =>
      commandResult('BRIDGE_PING', { nonce: 'other' }, { nonce: 'ping' }),
    ).toThrow('nonce mismatch');
  });
  it.each([
    '',
    ' ',
    'x'.repeat(129),
    'x\n',
    'x\u0000',
    'x\u007f',
    'x\u0085',
    '\ud800',
    4,
    null,
    undefined,
  ])('rejects invalid opaque identifier %#', (value) =>
    expect(() => externalId(value)).toThrow(),
  );
  it('normalizes identifiers without assigning UUID, Steam or FormID semantics', () => {
    expect(externalId('  personagem opaco:á/42  ')).toBe(
      'personagem opaco:á/42',
    );
    expect(
      characterPayload('CHARACTER_ITEM_GIVE', {
        characterId: ' c ',
        itemId: ' i ',
        quantity: 1,
      }),
    ).toEqual({ characterId: 'c', itemId: 'i', quantity: 1 });
  });
  it.each([0, -1, NaN, Infinity, 1.5, 10001, Number.MAX_SAFE_INTEGER, '1'])(
    'rejects quantity %s',
    (value) => expect(() => quantity(value)).toThrow(),
  );
  it.each([1, 10000])('accepts bounded integer quantity %s', (value) =>
    expect(quantity(value)).toBe(value),
  );
  it.each([undefined, '', 'a b', 'a\n', 'a,b', 'x'.repeat(129), ['a', 'b']])(
    'requires a safe Idempotency-Key %#',
    (key) => expect(() => idempotencyKey(key)).toThrow(),
  );
  it('keeps keys exact and supports canonical reordered payloads', () => {
    expect(idempotencyKey('request:1._-')).toBe('request:1._-');
    expect(
      sameCommand(
        {
          type: 'CHARACTER_ITEM_GIVE',
          payload: { characterId: 'c', itemId: 'i', quantity: 2 },
        },
        'CHARACTER_ITEM_GIVE',
        { quantity: 2, itemId: 'i', characterId: 'c' },
      ),
    ).toBe(true);
  });
  it.each([
    { characterId: 'c', items: [{ itemId: 'i', quantity: 0 }] },
    { characterId: 'c', items: [{ itemId: 'i', quantity: 1, script: 'x' }] },
    {
      characterId: 'c',
      items: [{ itemId: 'i', quantity: 1, displayName: 'x'.repeat(129) }],
    },
    {
      characterId: 'c',
      items: Array.from({ length: 513 }, () => ({ itemId: 'i', quantity: 1 })),
    },
  ])('rejects invalid inventory result %#', (result) =>
    expect(() =>
      characterResult('CHARACTER_INVENTORY_QUERY', result, {
        characterId: 'c',
      }),
    ).toThrow(),
  );
  it('requires applied true and the correct mutation target', () => {
    const payload = { characterId: 'c', itemId: 'i', quantity: 1 };
    expect(() =>
      characterResult(
        'CHARACTER_ITEM_GIVE',
        { characterId: 'c', applied: false, targetId: 'i' },
        payload,
      ),
    ).toThrow();
    expect(() =>
      characterResult(
        'CHARACTER_ITEM_GIVE',
        { characterId: 'c', applied: true, targetId: 'other' },
        payload,
      ),
    ).toThrow('target mismatch');
  });
  it('never invokes getters or arbitrary toJSON when validating character data', () => {
    expect(() =>
      characterPayload('CHARACTER_INVENTORY_QUERY', {
        get characterId() {
          throw new Error('getter invoked');
        },
      }),
    ).toThrow('Invalid JSON');
    expect(() =>
      characterPayload('CHARACTER_INVENTORY_QUERY', {
        characterId: 'c',
        toJSON: () => ({ characterId: 'c' }),
      }),
    ).toThrow('Invalid JSON');
  });
  it('separates payload and result limits, including JSONB whitespace at the exact boundary', () => {
    expect(MAX_COMMAND_PAYLOAD_BYTES).toBe(4096);
    expect(MAX_COMMAND_RESULT_BYTES).toBe(65536);
    const large = {
      characterId: 'c',
      items: Array.from({ length: 80 }, (_, i) => ({
        itemId: String(i),
        quantity: 1,
        displayName: 'x'.repeat(128),
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(4096);
    expect(
      characterResult('CHARACTER_INVENTORY_QUERY', large, { characterId: 'c' }),
    ).toEqual(large);
    expect(() =>
      characterPayload('CHARACTER_INVENTORY_QUERY', {
        characterId: 'c',
        extra: 'x'.repeat(4096),
      }),
    ).toThrow('size limit');
    expect(() => commandJson({ x: 'x'.repeat(65527) }, 65536)).not.toThrow();
    expect(() => commandJson({ x: 'x'.repeat(65528) }, 65536)).toThrow(
      'size limit',
    );
    expect(() =>
      characterResult(
        'CHARACTER_INVENTORY_QUERY',
        {
          characterId: 'c',
          items: Array.from({ length: 512 }, () => ({
            itemId: 'i'.repeat(128),
            displayName: 'n'.repeat(128),
            quantity: 1,
          })),
        },
        { characterId: 'c' },
      ),
    ).toThrow('size limit');
  });
  it('rejects mass assignment and non-integer DTO bodies', async () => {
    for (const body of [
      { itemId: 'i', quantity: '1' },
      { itemId: 'i', quantity: 1, requestedByStaffId: randomUUID() },
      { itemId: 'i', quantity: 1, characterId: 'other' },
    ]) {
      expect(
        (
          await validate(plainToInstance(ItemBodyDto, body), {
            whitelist: true,
            forbidNonWhitelisted: true,
          })
        ).length,
      ).toBeGreaterThan(0);
    }
    expect(
      (
        await validate(
          plainToInstance(CharacterQueryBodyDto, { command: 'anything' }),
          {
            whitelist: true,
            forbidNonWhitelisted: true,
            forbidUnknownValues: false,
          },
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('Character operation presentation and audit', () => {
  it.each(CHARACTER_CASES)(
    'exposes typed domain content but only operational generic metadata for $type',
    (sample) => {
      const command = Object.assign(new GameCommand(), {
        id: randomUUID(),
        gameServerId: randomUUID(),
        type: sample.type,
        payload: sample.payload,
        status: S.SUCCEEDED,
        correlationId: randomUUID(),
        requestId: 'request',
        createdAt: new Date(),
        dispatchLeaseId: 'secret-lease',
        dispatchLeaseExpiresAt: new Date(),
        idempotencyKey: 'secret-key',
        result: Object.assign(new GameCommandResult(), {
          outcome: S.SUCCEEDED,
          result: sample.result,
          errorCode: null,
          errorMessage: null,
          receivedAt: new Date(),
        }),
      });
      const reference = operationReference(command);
      expect(reference).toMatchObject({
        commandId: command.id,
        characterId: sample.payload.characterId,
        type: sample.type,
      });
      expect(reference).not.toHaveProperty('payload');
      const detail = operationDetail(command);
      expect(detail.payload).toEqual(sample.payload);
      expect(detail.result?.result).toEqual(sample.result);
      const generic = commandDetail(command);
      expect(generic).not.toHaveProperty('payload');
      expect(generic.result).not.toHaveProperty('result');
      expect(JSON.stringify(generic)).not.toMatch(
        /characterId|itemId|inventory|factions|properties/,
      );
      expect(JSON.stringify([reference, detail, generic])).not.toMatch(
        /secret-|dispatchLease|idempotencyKey/,
      );
      if (sample.action) {
        const metadata = characterAuditMetadata(command);
        expect(metadata).toMatchObject({
          gameServerId: command.gameServerId,
          commandId: command.id,
          correlationId: command.correlationId,
          characterId: sample.payload.characterId,
          operation: sample.type,
          targetId: 'opaque:target-1',
        });
        expect(Object.keys(metadata).sort()).toEqual(
          [
            'characterId',
            'commandId',
            'correlationId',
            'gameServerId',
            'operation',
            'targetId',
            ...('quantity' in sample.payload ? ['quantity'] : []),
          ].sort(),
        );
        expect(sanitizeMetadata(metadata)).toEqual(metadata);
        expect(JSON.stringify(metadata)).not.toMatch(
          /payload|result|secret-|idempotency|token|header|lease/i,
        );
      }
    },
  );
  it('rejects a ping on the domain presenter', () =>
    expect(() =>
      operationReference(
        Object.assign(new GameCommand(), { type: 'BRIDGE_PING' }),
      ),
    ).toThrow('Character operation not found'));
  it('rejects an invalid Character RESULT without completing the command, then accepts a valid one', async () => {
    const f = gameFixture();
    f.command.type = 'CHARACTER_INVENTORY_QUERY';
    f.command.payload = { characterId: 'c' };
    await f.dispatcher.dispatch(f.command.id);
    await expect(
      f.receiver.result({
        ...f.ack(),
        outcome: S.SUCCEEDED,
        result: { anything: [] },
      } as unknown as ResultMessage),
    ).rejects.toThrow();
    expect(f.command.status).toBe(S.DISPATCHED);
    expect(f.results()).toHaveLength(0);
    await f.receiver.result({
      ...f.ack(),
      outcome: S.SUCCEEDED,
      result: { characterId: 'c', items: [] },
    });
    expect(f.command.status).toBe(S.SUCCEEDED);
    await f.receiver.result({
      ...f.ack(),
      outcome: S.SUCCEEDED,
      result: { items: [], characterId: 'c' },
    });
    expect(f.results()).toHaveLength(1);
  });
});
