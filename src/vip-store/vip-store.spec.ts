import {
  newOffer,
  offerPatch,
  offerCode,
  offerInteger,
  vipRewards,
  MAX_PRICE_MINOR,
} from './vip-offer.contracts.js';
import { publicOffer } from './vip-offer.presenter.js';
import { VipOffer } from './entities/vip-offer.entity.js';
import { VipAdminService } from './vip-admin.service.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { StaffUser } from '../staff/entities/staff-user.entity.js';
import { Permission as P } from '../rbac/permissions.js';
import { RoleName as R } from '../rbac/roles.js';
import { ROLE_PERMISSIONS } from '../rbac/role-permissions.js';
import type { DataSource } from 'typeorm';
import type { AuditService } from '../audit/audit.service.js';
const input = () => ({
  code: 'vip_gold',
  name: 'Gold',
  description: 'Description',
  priceMinor: 1990,
  currency: 'BRL',
  rewards: [{ type: 'ITEM', itemId: 'item', quantity: 1 }],
});
describe('VIP catalog contracts', () => {
  it('normalizes and snapshots typed data with conservative inactive defaults', () => {
    const raw = {
      ...input(),
      code: ' VIP_GOLD ',
      name: ' Gold ',
      description: ' First\nSecond ',
      rewards: [{ type: 'ITEM', itemId: ' item ', quantity: 10000 }],
    };
    const offer = newOffer(raw);
    raw.rewards[0].quantity = 1;
    expect(offer).toEqual({
      ...raw,
      code: 'vip_gold',
      name: 'Gold',
      description: 'First\nSecond',
      active: false,
      sortOrder: 0,
      rewards: [{ type: 'ITEM', itemId: 'item', quantity: 10000 }],
    });
  });
  it.each([
    NaN,
    Infinity,
    -Infinity,
    1.1,
    -1,
    2147483648,
    '100',
    null,
    undefined,
    true,
  ])('rejects unsafe or coerced price %#', (priceMinor) => {
    expect(() => newOffer({ ...input(), priceMinor })).toThrow();
    expect(() => offerInteger(priceMinor, MAX_PRICE_MINOR)).toThrow();
    expect(() => offerPatch({ priceMinor })).toThrow();
  });
  it.each([0, 1, 1990, MAX_PRICE_MINOR])(
    'preserves exact integer monetary value %s',
    (priceMinor) => {
      expect(newOffer({ ...input(), priceMinor }).priceMinor).toBe(priceMinor);
    },
  );
  it.each([
    { type: 'ITEM', itemId: ' i ', quantity: 1 },
    { type: 'HORSE', horseId: ' h ' },
    { type: 'TITLE', titleId: ' t ' },
    { type: 'SPELL', spellId: ' s ' },
  ])('supports $type as a definition without an execution target', (reward) => {
    const result = vipRewards([reward]);
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('characterId');
    expect(() =>
      vipRewards([{ ...reward, characterId: 'player-character' }]),
    ).toThrow();
    expect(() => vipRewards([{ ...reward, rawCommand: 'execute' }])).toThrow();
  });
  it.each([
    null,
    {},
    [],
    [null],
    [{ type: 'ITEM', itemId: 'i' }],
    [{ type: 'ITEM', itemId: 'i', quantity: 0 }],
    [{ type: 'ITEM', itemId: 'i', quantity: '1' }],
    [{ type: 'ITEM', itemId: 'i', quantity: 10001 }],
    [{ type: 'HORSE', horseId: 'h', quantity: 1 }],
    [{ type: 'TITLE', titleId: 'x\n' }],
    [{ type: 'SPELL', spellId: '\ud800' }],
    [{ type: 'HORSE', horseId: 'x'.repeat(129) }],
    [{ type: 'SCRIPT', script: 'x' }],
    [{ type: 'COMMAND', payload: {} }],
    Array.from({ length: 21 }, () => ({ type: 'TITLE', titleId: 't' })),
  ])(
    'rejects malformed, arbitrary or oversized reward definition %#',
    (value) => {
      expect(() => vipRewards(value)).toThrow();
    },
  );
  it('rejects hostile objects without calling getters or toJSON', () => {
    expect(() =>
      newOffer({
        ...input(),
        get name() {
          throw new Error('invoked');
        },
      }),
    ).toThrow('Invalid JSON');
    expect(() =>
      vipRewards([
        {
          type: 'TITLE',
          titleId: 't',
          toJSON() {
            throw new Error('invoked');
          },
        },
      ]),
    ).toThrow('Invalid JSON');
  });
  it('requires a nonempty closed patch and preserves unspecified fields', () => {
    expect(offerPatch({ priceMinor: 100 })).toEqual({ priceMinor: 100 });
    expect(offerPatch({ description: '' })).toEqual({ description: '' });
    for (const value of [
      {},
      { code: 'other' },
      { active: true },
      { id: 'other' },
      { name: null },
      { description: null },
      { rewards: null },
      { sortOrder: null },
    ])
      expect(() => offerPatch(value)).toThrow();
  });
  it('normalizes code and bounds literal text without interpreting markup', () => {
    expect(offerCode(' VIP_GOLD ')).toBe('vip_gold');
    for (const value of ['ab', 'a'.repeat(65), 'bad code', 'x/y', null, 1])
      expect(() => offerCode(value)).toThrow();
    expect(
      newOffer({ ...input(), name: '<literal>', description: 'line 1\nline 2' })
        .name,
    ).toBe('<literal>');
    for (const name of ['', ' ', 'x'.repeat(101), 'x\n', '\u0000', '\ud800'])
      expect(() => newOffer({ ...input(), name })).toThrow();
  });
  it('projects only the stable public allowlist and copies rewards', () => {
    const offer = Object.assign(new VipOffer(), newOffer(input()), {
      id: 'stable-id',
      createdAt: new Date(),
      updatedAt: new Date(),
      internalSecret: 'hidden',
    });
    const projected = publicOffer(offer);
    expect(Object.keys(projected).sort()).toEqual(
      [
        'id',
        'code',
        'name',
        'description',
        'priceMinor',
        'currency',
        'rewards',
      ].sort(),
    );
    expect(JSON.stringify(projected)).not.toMatch(
      /internalSecret|active|sortOrder|createdAt|updatedAt/,
    );
    projected.rewards.splice(0);
    expect(offer.rewards).toHaveLength(1);
  });
  it.each(Object.values(R))(
    'grants administration only to Coordinator: %s',
    (role) => {
      expect(
        ROLE_PERMISSIONS[role].filter((p) => p.startsWith('VIP_STORE_')).sort(),
      ).toEqual(
        role === R.COORDINATOR ? [P.VIP_STORE_READ, P.VIP_STORE_WRITE] : [],
      );
    },
  );
  it('rejects domain calls without permissions before persistence or Audit', async () => {
    const service = new VipAdminService({} as DataSource, {} as AuditService);
    const auth: AuthenticatedStaff = {
      user: new StaffUser(),
      sessionId: 's',
      permissions: [],
    };
    await expect(service.create(input(), auth)).rejects.toThrow(
      'Missing required permissions',
    );
    await expect(service.update('id', { name: 'x' }, auth)).rejects.toThrow(
      'Missing required permissions',
    );
    await expect(service.setActive('id', true, auth)).rejects.toThrow(
      'Missing required permissions',
    );
    await expect(service.list({ page: 1, limit: 20 }, auth)).rejects.toThrow(
      'Missing required permissions',
    );
    await expect(service.get('id', auth)).rejects.toThrow(
      'Missing required permissions',
    );
  });
});
