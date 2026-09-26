import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DataSource } from 'typeorm';
import {
  playerActor,
  staffActor,
  SystemSource,
  systemActor,
} from '../actors/actor.contracts.js';
import { RoleName as R } from '../rbac/roles.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import type { LedgerPosting } from './economy-ledger.service.js';
import {
  Currency,
  EconomyOwnerType as O,
  EconomyTransactionType as T,
  MAX_CHARACTER_BALANCE,
  MAX_SYSTEM_BALANCE_MAGNITUDE,
  MAX_TRANSACTION_AMOUNT,
  SystemAccountKey,
} from './economy.contracts.js';

// Any database access fails the test: invalid postings stop before it.
const untouched = new Proxy(
  {},
  {
    get: () => {
      throw new Error('database touched');
    },
  },
) as DataSource;
const ledger = new EconomyLedgerService(untouched);
const character = (id: string) =>
  ({ ownerType: O.CHARACTER, characterExternalId: id }) as const;
const mint = { ownerType: O.SYSTEM, systemKey: SystemAccountKey.MINT } as const;
const posting = (patch: Partial<LedgerPosting> = {}): LedgerPosting => ({
  gameServerId: '00000000-0000-4000-8000-000000000001',
  currency: Currency.GOLD,
  type: T.SYSTEM_CREDIT,
  actor: systemActor(SystemSource.AGENT),
  idempotencyKey: 'key-1',
  legs: [
    { account: mint, amount: -10 },
    { account: character('c1'), amount: 10 },
  ],
  ...patch,
});

describe('Economy ledger validation', () => {
  it.each([
    [
      'unbalanced legs',
      {
        legs: [
          { account: mint, amount: -10 },
          { account: character('c1'), amount: 9 },
        ],
      },
    ],
    ['a single leg', { legs: [{ account: character('c1'), amount: 0 }] }],
    [
      'a zero leg',
      {
        legs: [
          { account: mint, amount: 0 },
          { account: character('c1'), amount: 0 },
        ],
      },
    ],
    [
      'fractional amounts',
      {
        legs: [
          { account: mint, amount: -1.5 },
          { account: character('c1'), amount: 1.5 },
        ],
      },
    ],
    [
      'an oversized amount',
      {
        legs: [
          { account: mint, amount: -(MAX_TRANSACTION_AMOUNT + 1) },
          { account: character('c1'), amount: MAX_TRANSACTION_AMOUNT + 1 },
        ],
      },
    ],
    [
      'the same account twice',
      {
        legs: [
          { account: character('c1'), amount: -1 },
          { account: character(' c1 '), amount: 1 },
        ],
      },
    ],
    [
      'an unknown system key',
      {
        legs: [
          {
            account: {
              ownerType: O.SYSTEM,
              systemKey: 'AUCTION_ESCROW' as SystemAccountKey,
            },
            amount: -1,
          },
          { account: character('c1'), amount: 1 },
        ],
      },
    ],
    [
      'an invalid character id',
      {
        legs: [
          { account: mint, amount: -1 },
          { account: character('a\u0000'), amount: 1 },
        ],
      },
    ],
    ['another currency', { currency: 'SILVER' as Currency }],
    ['an unknown type', { type: 'REFUND' as T }],
    ['an invalid server', { gameServerId: 'x' }],
    ['an invalid key', { idempotencyKey: 'bad key' }],
    ['an invalid reference', { reference: { type: 'lower', id: 'x' } }],
    [
      'a PLAYER system credit',
      { actor: playerActor('00000000-0000-4000-8000-000000000002') },
    ],
    [
      'a STAFF system debit',
      {
        type: T.SYSTEM_DEBIT,
        actor: staffActor({
          id: 's',
          username: 'u',
          displayName: 'd',
          roleName: R.COORDINATOR,
        }),
      },
    ],
    [
      'a forged actor',
      { actor: { type: 'SYSTEM', source: 'MARKET' } as never },
    ],
  ] as const)(
    'rejects %s before touching the database',
    async (_name, patch) => {
      await expect(
        ledger.post(posting(patch as Partial<LedgerPosting>)),
      ).resolves.toEqual({
        outcome: 'REJECTED',
        reason: 'INVALID_INPUT',
      });
    },
  );
  it('keeps limits within safe integers and the character ceiling', () => {
    expect(MAX_CHARACTER_BALANCE).toBe(1_000_000_000_000);
    expect(MAX_TRANSACTION_AMOUNT).toBe(MAX_CHARACTER_BALANCE);
    expect(MAX_SYSTEM_BALANCE_MAGNITUDE).toBeLessThanOrEqual(
      Number.MAX_SAFE_INTEGER,
    );
    expect(Object.values(Currency)).toEqual(['GOLD']);
    expect(Object.values(SystemAccountKey)).toEqual([
      'MINT',
      'BURN',
      'TRADE_ESCROW',
      'MARKET_ESCROW',
      'ADJUSTMENT',
    ]);
    expect(Object.values(T)).toEqual([
      'SYSTEM_CREDIT',
      'SYSTEM_DEBIT',
      'TRANSFER',
      'STAFF_ADJUSTMENT',
    ]);
  });
});

describe('Economy boundaries', () => {
  const sources = globSync(fileURLToPath(new URL('./**/*.ts', import.meta.url)))
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => [file, readFileSync(file, 'utf8')] as const);
  it('has no game command, Agent transport, realtime or Skyrim gold coupling', () => {
    for (const [, source] of sources)
      for (const [, module] of source.matchAll(/from '([^']+)'/g))
        expect(module).not.toMatch(
          /game-command|character-management|realtime|player-groups|player-guilds|^ws$/,
        );
  });
  it('exposes only GET routes to players', () => {
    const controller = sources.find(([file]) =>
      file.endsWith('wallet.controller.ts'),
    )![1];
    expect(controller).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
  });
});
