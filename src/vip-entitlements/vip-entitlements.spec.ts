import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DataSource } from 'typeorm';
import { REALTIME_EVENT_TYPES } from '../realtime-events/realtime-event-bus.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import { AuditAction, AuditResource } from '../audit/audit.types.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  playerActor,
  systemActor,
  SystemSource,
} from '../actors/actor.contracts.js';
import {
  newOffer,
  offerPatch,
  VipEntitlementScope,
} from '../vip-store/vip-offer.contracts.js';
import {
  deliveryIdempotencyKey,
  rewardCommand,
} from './vip-delivery.contracts.js';
import { COMMAND_TYPES } from '../game-bridge/command-contract.js';
import { VipEntitlementService } from './vip-entitlement.service.js';
import {
  EntitlementOperation,
  EntitlementStatus,
} from './vip-entitlement.contracts.js';

const offer = () => ({
  code: 'vip_gold',
  name: 'Gold',
  description: '',
  priceMinor: 100,
  currency: 'BRL',
  rewards: [{ type: 'TITLE', titleId: 'hero' }],
});

describe('VIP entitlement contracts', () => {
  it('has closed scopes, statuses, operations, audit actions and events', () => {
    expect(Object.values(VipEntitlementScope)).toEqual(['PLAYER', 'CHARACTER']);
    expect(Object.values(EntitlementStatus)).toEqual([
      'ACTIVE',
      'REVOKED',
      'EXPIRED',
    ]);
    expect(Object.values(EntitlementOperation)).toEqual(['GRANT', 'REVOKE']);
    expect([
      AuditAction.VIP_ENTITLEMENT_GRANTED,
      AuditAction.VIP_ENTITLEMENT_REVOKED,
      AuditResource.VIP_ENTITLEMENT,
    ]).toEqual([
      'VIP_ENTITLEMENT_GRANTED',
      'VIP_ENTITLEMENT_REVOKED',
      'VIP_ENTITLEMENT',
    ]);
    expect(REALTIME_EVENT_TYPES.filter((t) => t.startsWith('VIP_'))).toEqual([
      'VIP_ENTITLEMENT_GRANTED',
      'VIP_ENTITLEMENT_REVOKED',
    ]);
  });
  it('makes the offer scope explicit, defaulting to CHARACTER, never inferred', () => {
    expect(newOffer(offer()).entitlementScope).toBe('CHARACTER');
    // A PLAYER-looking code or name does not change the scope.
    expect(
      newOffer({ ...offer(), code: 'vip_account', name: 'Account perk' })
        .entitlementScope,
    ).toBe('CHARACTER');
    expect(
      newOffer({ ...offer(), entitlementScope: 'PLAYER' }).entitlementScope,
    ).toBe('PLAYER');
    expect(offerPatch({ entitlementScope: 'CHARACTER' })).toEqual({
      entitlementScope: 'CHARACTER',
    });
    for (const value of ['player', 'ACCOUNT', null, 1])
      expect(() => newOffer({ ...offer(), entitlementScope: value })).toThrow(
        'Supported entitlement scopes',
      );
  });
});

describe('VIP entitlement authority', () => {
  // Rejections happen before any database or Audit access.
  const service = new VipEntitlementService(
    {} as DataSource,
    {} as AuditService,
    new RealtimeEventBus(),
  );
  const valid = {
    offerId: '00000000-0000-4000-8000-000000000001',
    target: {
      scope: VipEntitlementScope.PLAYER,
      playerId: '00000000-0000-4000-8000-000000000002',
    } as const,
    actor: systemActor(SystemSource.VIP_DELIVERY),
    idempotencyKey: 'grant-1',
  };
  it('never lets a player grant or revoke', async () => {
    const actor = playerActor('00000000-0000-4000-8000-000000000002');
    await expect(service.grant({ ...valid, actor })).resolves.toEqual({
      outcome: 'REJECTED',
      reason: 'ACTOR_NOT_ALLOWED',
    });
    await expect(
      service.revoke({
        entitlementId: valid.offerId,
        actor,
        idempotencyKey: 'r',
      }),
    ).resolves.toEqual({ outcome: 'REJECTED', reason: 'ACTOR_NOT_ALLOWED' });
    await expect(
      service.grant({ ...valid, actor: { type: 'STAFF' } as never }),
    ).resolves.toEqual({ outcome: 'REJECTED', reason: 'ACTOR_NOT_ALLOWED' });
  });
  it.each([
    { offerId: 'nope' },
    { idempotencyKey: '' },
    { idempotencyKey: 'bad key' },
    { target: { scope: 'PLAYER', playerId: 'x' } },
    {
      target: {
        scope: 'CHARACTER',
        gameServerId: 'x',
        characterExternalId: 'c',
      },
    },
    {
      target: {
        scope: 'CHARACTER',
        gameServerId: '00000000-0000-4000-8000-000000000003',
        characterExternalId: ' ',
      },
    },
    { target: { scope: 'ACCOUNT', playerId: valid.target.playerId } },
    { expiresAt: new Date('invalid') },
    { expiresAt: '2030-01-01' },
    { externalReference: 'a\u0000b' },
    { externalReference: 'x'.repeat(129) },
  ])('rejects invalid grant input %#', async (patch) => {
    await expect(
      service.grant({ ...valid, ...(patch as object) } as never),
    ).resolves.toEqual({ outcome: 'REJECTED', reason: 'INVALID_INPUT' });
  });
  it('maps every reward type to one existing typed GameCommand, and nothing else', () => {
    const c = 'char:1';
    expect(
      rewardCommand({ type: 'ITEM', itemId: 'i', quantity: 2 }, c),
    ).toEqual({
      type: 'CHARACTER_ITEM_GIVE',
      payload: { characterId: c, itemId: 'i', quantity: 2 },
    });
    expect(rewardCommand({ type: 'HORSE', horseId: 'h' }, c)).toEqual({
      type: 'CHARACTER_HORSE_GIVE',
      payload: { characterId: c, horseId: 'h' },
    });
    expect(rewardCommand({ type: 'TITLE', titleId: 't' }, c)).toEqual({
      type: 'CHARACTER_TITLE_GIVE',
      payload: { characterId: c, titleId: 't' },
    });
    expect(rewardCommand({ type: 'SPELL', spellId: 's' }, c)).toEqual({
      type: 'CHARACTER_SPELL_GIVE',
      payload: { characterId: c, spellId: 's' },
    });
    // No typed command, no delivery: never a raw/console fallback.
    for (const unknown of [
      { type: 'CONSOLE', command: 'player.additem f 1' },
      { type: 'PAPYRUS', script: 'x' },
      { type: 'GOLD', amount: 100 },
    ])
      expect(rewardCommand(unknown as never, c)).toBeNull();
    expect(deliveryIdempotencyKey('d-1')).toBe('vip-delivery:d-1');
    for (const type of COMMAND_TYPES)
      expect(type).not.toMatch(/CONSOLE|PAPYRUS|SCRIPT|RAW|EXECUTE/);
  });
});

describe('VIP entitlement boundaries', () => {
  const sources = globSync(fileURLToPath(new URL('./**/*.ts', import.meta.url)))
    .filter((file) => !file.endsWith('.spec.ts'))
    // Code only: comments may name what is deliberately absent.
    .map(
      (file) =>
        [
          file,
          readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, ''),
        ] as const,
    );
  it('reaches the game only through typed GameCommands of the delivery, and processes no payment', () => {
    for (const [file, source] of sources) {
      const delivery =
        /vip-delivery\.|vip-reward-delivery\.entity|vip-entitlements\.module/.test(
          file,
        );
      for (const [, module] of source.matchAll(/from '([^']+)'/g)) {
        expect(module).not.toMatch(
          /character-management|player-character-operations|administrative-operations|economy|\/realtime\/|^ws$/,
        );
        if (!delivery) expect(module).not.toMatch(/game-command|game-agent/);
      }
      expect(source).not.toMatch(/checkout|payment|console|papyrus/i);
      if (!delivery)
        expect(source).not.toMatch(
          /GameCommand|CHARACTER_ITEM_GIVE|CHARACTER_HORSE_GIVE|CHARACTER_TITLE_GIVE|CHARACTER_SPELL_GIVE/,
        );
    }
  });
  it('exposes only reads to players', () => {
    const controller = sources.find(([file]) =>
      file.endsWith('vip-entitlement.controller.ts'),
    )![1];
    expect(controller).not.toMatch(/@(Post|Put|Patch|Delete)\(|grant|revoke/);
  });
});
