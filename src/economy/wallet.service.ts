import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { pageResult } from '../admin-queries/query-pagination.js';
import type { PlayerActor } from '../actors/actor.contracts.js';
import type { PlayerCharacter } from '../player-characters/entities/player-character.entity.js';
import { CharacterLinkStatus } from '../player-characters/player-character.contracts.js';
import { EconomyLedgerService } from './economy-ledger.service.js';
import { Currency, EntryDirection } from './economy.contracts.js';
import type { EconomyEntry } from './entities/economy-entry.entity.js';
import type {
  WalletDto,
  WalletTransactionDto,
  WalletTransactionsQueryDto,
} from './dto/wallet.dto.js';

type EntryWithTransaction = EconomyEntry & {
  transaction: {
    id: string;
    type: WalletTransactionDto['type'];
    referenceType: string | null;
    referenceId: string | null;
    createdAt: Date;
  };
};

// Read-only wallet of an owned character. The own VERIFIED link only
// authorizes; the wallet is the character identity's account. Reads never
// create accounts.
@Injectable()
export class WalletService {
  constructor(
    private readonly database: DataSource,
    private readonly ledger: EconomyLedgerService,
  ) {}
  private async ownLink(actor: PlayerActor, id: string) {
    const link = await this.database
      .getRepository<PlayerCharacter>('PlayerCharacter')
      .findOneBy({
        id,
        playerId: actor.playerId,
        status: CharacterLinkStatus.VERIFIED,
      });
    if (!link) throw new NotFoundException('Character not found');
    return link;
  }
  async wallet(
    actor: PlayerActor,
    characterLinkId: string,
  ): Promise<WalletDto> {
    const link = await this.ownLink(actor, characterLinkId);
    return {
      characterLinkId: link.id,
      currency: Currency.GOLD,
      balance: await this.ledger.characterBalance(
        link.gameServerId,
        Currency.GOLD,
        link.characterExternalId,
      ),
    };
  }
  // Only this character's legs: counterparties, system accounts and
  // attribution are never part of the view.
  async transactions(
    actor: PlayerActor,
    characterLinkId: string,
    query: WalletTransactionsQueryDto,
  ) {
    const link = await this.ownLink(actor, characterLinkId);
    const [entries, total] = await this.database
      .getRepository<EntryWithTransaction>('EconomyEntry')
      .createQueryBuilder('entry')
      .innerJoin('entry.account', 'account')
      .innerJoinAndSelect('entry.transaction', 'tx')
      .where('account.gameServerId = :server', { server: link.gameServerId })
      .andWhere('account.currency = :currency', { currency: Currency.GOLD })
      .andWhere(`account.ownerType = 'CHARACTER'`)
      .andWhere('account.characterExternalId = :character', {
        character: link.characterExternalId,
      })
      .orderBy('tx.createdAt', 'DESC')
      .addOrderBy('tx.id', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();
    return pageResult(
      entries.map((entry): WalletTransactionDto => ({
        transactionId: entry.transaction.id,
        type: entry.transaction.type,
        amount: Math.abs(entry.amount),
        direction:
          entry.amount > 0 ? EntryDirection.CREDIT : EntryDirection.DEBIT,
        referenceType: entry.transaction.referenceType,
        referenceId: entry.transaction.referenceId,
        createdAt: entry.transaction.createdAt,
      })),
      total,
      query,
    );
  }
}
