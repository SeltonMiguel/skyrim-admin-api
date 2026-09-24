import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import { systemActor } from '../actors/actor.contracts.js';
import type { Actor, SystemSource } from '../actors/actor.contracts.js';
import { externalId } from '../game-bridge/command-validation.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import {
  Currency,
  EconomyOwnerType,
  EconomyTransactionType,
  MAX_TRANSACTION_AMOUNT,
  SystemAccountKey,
} from './economy.contracts.js';
import type {
  EconomyMutationResult,
  LedgerReference,
  LedgerResult,
} from './economy.contracts.js';

export interface SystemMovement {
  gameServerId: string;
  characterExternalId: string;
  amount: number;
  idempotencyKey: string;
  source: SystemSource;
  reference?: LedgerReference;
}
export interface InternalTransfer {
  gameServerId: string;
  currency: Currency;
  fromCharacterId: string;
  toCharacterId: string;
  amount: number;
  actor: Actor;
  idempotencyKey: string;
  reference?: LedgerReference;
}
const invalid: EconomyMutationResult = {
  outcome: 'REJECTED',
  reason: 'INVALID_INPUT',
};
const validAmount = (amount: number) =>
  Number.isSafeInteger(amount) &&
  amount > 0 &&
  amount <= MAX_TRANSACTION_AMOUNT;

// Trusted internal entry points; there is no HTTP route that moves money.
// Wallets belong to the character identity (server + external id), never to
// an ownership link.
@Injectable()
export class EconomyService {
  constructor(
    private readonly ledger: EconomyLedgerService,
    private readonly audit: AuditService,
  ) {}
  // MINT -> character.
  creditFromSystem(input: SystemMovement): Promise<EconomyMutationResult> {
    return this.system(input, EconomyTransactionType.SYSTEM_CREDIT);
  }
  // Character -> BURN; never below zero.
  debitFromSystem(input: SystemMovement): Promise<EconomyMutationResult> {
    return this.system(input, EconomyTransactionType.SYSTEM_DEBIT);
  }
  // Infrastructure for Trade (10.13): not exposed to players, not audited
  // here (the calling domain audits its own business action).
  async transfer(input: InternalTransfer): Promise<LedgerResult> {
    let from: string, to: string;
    try {
      from = externalId(input.fromCharacterId);
      to = externalId(input.toCharacterId);
    } catch {
      return invalid;
    }
    if (from === to || !validAmount(input.amount)) return invalid;
    return this.ledger.post({
      gameServerId: input.gameServerId,
      currency: input.currency,
      type: EconomyTransactionType.TRANSFER,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      reference: input.reference,
      legs: [
        {
          account: {
            ownerType: EconomyOwnerType.CHARACTER,
            characterExternalId: from,
          },
          amount: -input.amount,
        },
        {
          account: {
            ownerType: EconomyOwnerType.CHARACTER,
            characterExternalId: to,
          },
          amount: input.amount,
        },
      ],
    });
  }

  private async system(
    input: SystemMovement,
    type:
      | EconomyTransactionType.SYSTEM_CREDIT
      | EconomyTransactionType.SYSTEM_DEBIT,
  ): Promise<EconomyMutationResult> {
    let characterExternalId: string, actor: Actor;
    try {
      characterExternalId = externalId(input.characterExternalId);
      actor = systemActor(input.source);
    } catch {
      return invalid;
    }
    if (!isUUID(input.gameServerId) || !validAmount(input.amount))
      return invalid;
    const { gameServerId, amount } = input;
    const credit = type === EconomyTransactionType.SYSTEM_CREDIT;
    const character = {
      ownerType: EconomyOwnerType.CHARACTER,
      characterExternalId,
    } as const;
    const system = {
      ownerType: EconomyOwnerType.SYSTEM,
      systemKey: credit ? SystemAccountKey.MINT : SystemAccountKey.BURN,
    } as const;
    let balance: number | undefined;
    const result = await this.ledger.post(
      {
        gameServerId,
        currency: Currency.GOLD,
        type,
        actor,
        idempotencyKey: input.idempotencyKey,
        reference: input.reference,
        legs: [
          { account: system, amount: credit ? -amount : amount },
          { account: character, amount: credit ? amount : -amount },
        ],
      },
      {
        authorize: (manager) =>
          this.ownerAvailable(manager, gameServerId, characterExternalId),
        posted: async (manager, transactionId, accounts) => {
          balance = [...accounts.values()].find(
            (a) => a.ref.ownerType === EconomyOwnerType.CHARACTER,
          )!.balance;
          await this.audit.record(
            {
              actor,
              action: credit
                ? AuditAction.ECONOMY_SYSTEM_CREDITED
                : AuditAction.ECONOMY_SYSTEM_DEBITED,
              resourceType: AuditResource.ECONOMY_TRANSACTION,
              resourceId: transactionId,
              metadata: {
                gameServerId,
                characterExternalId,
                currency: Currency.GOLD,
                amount,
                transactionId,
              },
              outcome: AuditOutcome.SUCCESS,
            },
            manager,
          );
        },
      },
    );
    if (result.outcome === 'REJECTED') return result;
    return {
      ...result,
      balance:
        balance ??
        (await this.ledger.characterBalance(
          gameServerId,
          Currency.GOLD,
          characterExternalId,
        )),
    };
  }
  // Same rule as Professions: a character whose current VERIFIED owner is
  // suspended or banned receives no system movement; without a current owner
  // the character's own wallet still moves (it belongs to the character).
  private async ownerAvailable(
    manager: EntityManager,
    gameServerId: string,
    characterExternalId: string,
  ) {
    const owner = await manager
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .findOne({
        where: {
          gameServerId,
          characterExternalId,
          status: CharacterLinkStatus.VERIFIED,
        },
        relations: { player: true },
      });
    if (owner && owner.player.status !== PlayerStatus.ACTIVE)
      return 'PLAYER_UNAVAILABLE' as const;
  }
}
