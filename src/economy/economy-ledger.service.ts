import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  actor as copyActor,
  ActorType,
  idempotencyScope,
} from '../actors/actor.contracts.js';
import type { Actor } from '../actors/actor.contracts.js';
import { idempotencyKey } from '../actor-operations/actor-command.service.js';
import { externalId } from '../game-bridge/command-validation.js';
import type { GameServer } from '../game-bridge/entities/game-server.entity.js';
import {
  accountKey,
  Currency,
  EconomyOwnerType,
  EconomyTransactionType,
  MAX_CHARACTER_BALANCE,
  MAX_SYSTEM_BALANCE_MAGNITUDE,
  MAX_TRANSACTION_AMOUNT,
  REFERENCE_TYPE_PATTERN,
  SystemAccountKey,
} from './economy.contracts.js';
import type {
  AccountRef,
  LedgerReference,
  LedgerRejection,
  LedgerResult,
} from './economy.contracts.js';
import type { EconomyTransaction } from './entities/economy-transaction.entity.js';

export interface LedgerLeg {
  account: AccountRef;
  amount: number;
}
export interface LedgerPosting {
  gameServerId: string;
  currency: Currency;
  type: EconomyTransactionType;
  actor: Actor;
  idempotencyKey: string;
  reference?: LedgerReference;
  legs: LedgerLeg[];
}
export interface LockedAccount {
  id: string;
  ref: AccountRef;
  balance: number;
}
export interface LedgerHooks {
  // Domain authorization inside the transaction, after the account locks.
  authorize?: (manager: EntityManager) => Promise<LedgerRejection | void>;
  // Runs after the entries in the same transaction (e.g. Audit): a failure
  // rolls the whole posting back.
  posted?: (
    manager: EntityManager,
    transactionId: string,
    accounts: Map<string, LockedAccount>,
  ) => Promise<void>;
}
interface Prepared {
  posting: LedgerPosting;
  actor: Actor;
  scope: string;
  key: string;
  fingerprint: string;
}
// Thrown inside the transaction to roll it back and report a rejection.
// postWithin() lets it reach the calling domain, which rolls back too.
export class LedgerRejectionError extends Error {
  constructor(readonly reason: LedgerRejection) {
    super(reason);
  }
}
const isUniqueViolation = (error: unknown, constraint: string) =>
  error instanceof QueryFailedError &&
  (error.driverError as { code?: string; constraint?: string }).code ===
    '23505' &&
  (error.driverError as { constraint?: string }).constraint === constraint;

// Internal double-entry core reused by Economy (10.12), Trade (10.13) and
// Marketplace (10.14). It never authorizes players: callers do.
//
// Locking: every account of a posting is created lazily and then locked
// FOR UPDATE in ascending id order, so concurrent postings over the same
// accounts serialize without deadlocks. Idempotency is checked again under
// those locks; the unique key is the final authority.
@Injectable()
export class EconomyLedgerService {
  constructor(private readonly database: DataSource) {}

  async post(
    posting: LedgerPosting,
    hooks: LedgerHooks = {},
  ): Promise<LedgerResult> {
    let prepared: Prepared;
    try {
      prepared = this.prepare(posting);
    } catch {
      return { outcome: 'REJECTED', reason: 'INVALID_INPUT' };
    }
    const replay = await this.replay(this.database.manager, prepared);
    if (replay) return replay;
    try {
      return await this.database.transaction((manager) =>
        this.apply(manager, prepared, hooks),
      );
    } catch (error) {
      if (error instanceof LedgerRejectionError)
        return { outcome: 'REJECTED', reason: error.reason };
      // A concurrent posting with the same key committed first.
      if (isUniqueViolation(error, 'economy_transactions_idempotency_key'))
        return (
          (await this.replay(this.database.manager, prepared)) ?? {
            outcome: 'REJECTED',
            reason: 'IDEMPOTENCY_CONFLICT',
          }
        );
      throw error;
    }
  }
  // Posts inside the caller's transaction (e.g. a trade state change), so
  // the ledger and the domain commit or roll back together. Any rejection
  // throws LedgerRejectionError; the caller must let it abort its work.
  async postWithin(
    manager: EntityManager,
    posting: LedgerPosting,
    hooks: LedgerHooks = {},
  ): Promise<{ transactionId: string; replayed: boolean }> {
    let prepared: Prepared;
    try {
      prepared = this.prepare(posting);
    } catch {
      throw new LedgerRejectionError('INVALID_INPUT');
    }
    const result = await this.apply(manager, prepared, hooks);
    if (result.outcome === 'REJECTED')
      throw new LedgerRejectionError(result.reason);
    return {
      transactionId: result.transactionId,
      replayed: result.outcome === 'ALREADY_POSTED',
    };
  }
  // Current balance of a character account; 0 when it does not exist yet.
  async characterBalance(
    gameServerId: string,
    currency: Currency,
    characterExternalId: string,
    manager: EntityManager = this.database.manager,
  ): Promise<number> {
    const [row] = await manager.query(
      `SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND currency = $2 AND owner_type = 'CHARACTER' AND character_external_id = $3`,
      [gameServerId, currency, characterExternalId],
    );
    return row ? Number(row.balance) : 0;
  }

  private prepare(posting: LedgerPosting): Prepared {
    const actor = copyActor(posting.actor);
    if (!isUUID(posting.gameServerId)) throw new Error('server');
    if (!Object.values(Currency).includes(posting.currency))
      throw new Error('currency');
    if (!Object.values(EconomyTransactionType).includes(posting.type))
      throw new Error('type');
    if (posting.type !== EconomyTransactionType.TRANSFER)
      if (actor.type !== ActorType.SYSTEM) throw new Error('actor');
    const legs = posting.legs.map((leg) => ({
      account: this.account(leg.account),
      amount: leg.amount,
    }));
    const keys = legs.map((leg) => accountKey(leg.account));
    if (
      legs.length < 2 ||
      new Set(keys).size !== keys.length ||
      legs.some(
        (leg) =>
          !Number.isSafeInteger(leg.amount) ||
          leg.amount === 0 ||
          Math.abs(leg.amount) > MAX_TRANSACTION_AMOUNT,
      ) ||
      legs.reduce((sum, leg) => sum + leg.amount, 0) !== 0
    )
      throw new Error('legs');
    const reference = posting.reference && {
      type: posting.reference.type,
      id: externalId(posting.reference.id),
    };
    if (reference && !REFERENCE_TYPE_PATTERN.test(reference.type))
      throw new Error('reference');
    const normalized = { ...posting, legs, reference };
    // Content identity of the request: the key may only replay this content.
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          normalized.type,
          normalized.currency,
          [...legs]
            .map((leg) => [accountKey(leg.account), leg.amount])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
          reference ? [reference.type, reference.id] : null,
        ]),
      )
      .digest('hex');
    return {
      posting: normalized,
      actor,
      scope: idempotencyScope(actor),
      key: idempotencyKey(posting.idempotencyKey),
      fingerprint,
    };
  }
  private account(ref: AccountRef): AccountRef {
    if (ref.ownerType === EconomyOwnerType.CHARACTER)
      return {
        ownerType: EconomyOwnerType.CHARACTER,
        characterExternalId: externalId(ref.characterExternalId),
      };
    if (
      ref.ownerType === EconomyOwnerType.SYSTEM &&
      Object.values(SystemAccountKey).includes(ref.systemKey)
    )
      return { ownerType: EconomyOwnerType.SYSTEM, systemKey: ref.systemKey };
    throw new Error('account');
  }
  private async replay(
    manager: EntityManager,
    prepared: Prepared,
  ): Promise<LedgerResult | null> {
    const existing = await manager
      .getRepository<EconomyTransaction>('EconomyTransaction')
      .findOne({
        where: {
          gameServerId: prepared.posting.gameServerId,
          idempotencyScope: prepared.scope,
          idempotencyKey: prepared.key,
        },
        select: { id: true, requestFingerprint: true },
      });
    if (!existing) return null;
    return existing.requestFingerprint === prepared.fingerprint
      ? { outcome: 'ALREADY_POSTED', transactionId: existing.id }
      : { outcome: 'REJECTED', reason: 'IDEMPOTENCY_CONFLICT' };
  }
  private async ensureAccount(
    manager: EntityManager,
    gameServerId: string,
    currency: Currency,
    ref: AccountRef,
  ): Promise<string> {
    const character = ref.ownerType === EconomyOwnerType.CHARACTER;
    const [column, value] = character
      ? ['character_external_id', ref.characterExternalId]
      : ['system_key', ref.systemKey];
    // Lazy creation; a concurrent creator makes this a no-op.
    await manager.query(
      `INSERT INTO economy_accounts(game_server_id, currency, owner_type, ${column}) VALUES ($1, $2, $3, $4) ON CONFLICT (game_server_id, currency, ${column}) WHERE owner_type = '${ref.ownerType}' DO NOTHING`,
      [gameServerId, currency, ref.ownerType, value],
    );
    const [row] = await manager.query(
      `SELECT id FROM economy_accounts WHERE game_server_id = $1 AND currency = $2 AND owner_type = $3 AND ${column} = $4`,
      [gameServerId, currency, ref.ownerType, value],
    );
    return row.id;
  }
  private async apply(
    manager: EntityManager,
    prepared: Prepared,
    hooks: LedgerHooks,
  ): Promise<LedgerResult> {
    const { posting, actor } = prepared;
    const server = await manager
      .getRepository<GameServer>('GameServer')
      .findOneBy({ id: posting.gameServerId });
    if (!server) throw new LedgerRejectionError('INVALID_INPUT');
    const ids = new Map<string, string>();
    for (const leg of posting.legs)
      ids.set(
        accountKey(leg.account),
        await this.ensureAccount(
          manager,
          posting.gameServerId,
          posting.currency,
          leg.account,
        ),
      );
    const rows: { id: string; balance: string }[] = await manager.query(
      'SELECT id, balance FROM economy_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[...ids.values()]],
    );
    const balances = new Map(rows.map((r) => [r.id, Number(r.balance)]));
    // Re-check under the locks: a concurrent identical posting may have won.
    const replay = await this.replay(manager, prepared);
    if (replay) return replay;
    const rejection = await hooks.authorize?.(manager);
    if (rejection) throw new LedgerRejectionError(rejection);
    const accounts = new Map<string, LockedAccount>();
    for (const leg of posting.legs) {
      const id = ids.get(accountKey(leg.account))!;
      const balance = balances.get(id)! + leg.amount;
      if (leg.account.ownerType === EconomyOwnerType.CHARACTER) {
        if (balance < 0) throw new LedgerRejectionError('INSUFFICIENT_FUNDS');
        if (balance > MAX_CHARACTER_BALANCE)
          throw new LedgerRejectionError('BALANCE_LIMIT');
      } else if (Math.abs(balance) > MAX_SYSTEM_BALANCE_MAGNITUDE)
        throw new LedgerRejectionError('SYSTEM_LIMIT');
      accounts.set(accountKey(leg.account), {
        id,
        ref: leg.account,
        balance,
      });
    }
    const transactionId = randomUUID();
    await manager
      .getRepository<EconomyTransaction>('EconomyTransaction')
      .insert({
        id: transactionId,
        gameServerId: posting.gameServerId,
        currency: posting.currency,
        type: posting.type,
        actorType: actor.type,
        actorPlayerId: actor.type === ActorType.PLAYER ? actor.playerId : null,
        actorStaffId: actor.type === ActorType.STAFF ? actor.id : null,
        actorSystemSource:
          actor.type === ActorType.SYSTEM ? actor.source : null,
        idempotencyScope: prepared.scope,
        idempotencyKey: prepared.key,
        requestFingerprint: prepared.fingerprint,
        referenceType: posting.reference?.type ?? null,
        referenceId: posting.reference?.id ?? null,
      });
    // Debits first; the entry trigger moves each balance in this transaction.
    for (const leg of [...posting.legs].sort((a, b) => a.amount - b.amount))
      await manager.query(
        'INSERT INTO economy_entries(transaction_id, account_id, game_server_id, currency, amount) VALUES ($1, $2, $3, $4, $5)',
        [
          transactionId,
          ids.get(accountKey(leg.account)),
          posting.gameServerId,
          posting.currency,
          leg.amount,
        ],
      );
    await hooks.posted?.(manager, transactionId, accounts);
    return { outcome: 'POSTED', transactionId };
  }
}
