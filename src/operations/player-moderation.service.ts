import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IsNull } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { staffActor } from '../actors/actor.contracts.js';
import { AuditAction, AuditResource } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import {
  EconomyLedgerService,
  LedgerRejectionError,
} from '../economy/economy-ledger.service.js';
import {
  Currency,
  EconomyOwnerType,
  EconomyTransactionType,
  EntryDirection,
  STAFF_ADJUSTMENT_REFERENCE_TYPE,
  SystemAccountKey,
} from '../economy/economy.contracts.js';
import type { Player } from '../player-accounts/entities/player.entity.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import type { PlayerSession } from '../player-auth/entities/player-session.entity.js';
import type { PlayerChatMessage } from '../player-chat/entities/player-chat-message.entity.js';
import { RealtimeSessionControl } from '../realtime-events/realtime-session-control.js';
import { OperatorActionKind, OperatorDomain } from './operations.contracts.js';
import { OperatorActionService } from './operator-action.service.js';

const lock = { mode: 'pessimistic_write' } as const;

// Staff moderation of Player accounts, wallets and chat (12.4), through
// the common operator action model (Idempotency-Key, reason, Audit, one
// transaction). Nothing here writes a balance, a session or a message
// directly outside its own invariants: status changes revoke sessions,
// wallet changes are ledger postings, chat moderation only hides.
@Injectable()
export class PlayerModerationService {
  constructor(
    private readonly actions: OperatorActionService,
    private readonly ledger: EconomyLedgerService,
    private readonly sessionControl: RealtimeSessionControl,
  ) {}

  // ACTIVE / SUSPENDED / BANNED. Leaving ACTIVE revokes every session of
  // the account in the same commit, then closes its realtime sockets.
  // Returning to ACTIVE never revives a session: the player logs in again.
  setPlayerStatus(
    auth: AuthenticatedStaff,
    key: unknown,
    playerId: string,
    status: PlayerStatus,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.PLAYER_ACCOUNT,
        action: OperatorActionKind.SET_STATUS,
        resourceId: playerId,
        reason,
        params: { status },
        audit: {
          action: AuditAction.PLAYER_ACCOUNT_STATUS_CHANGED,
          resourceType: AuditResource.PLAYER_ACCOUNT,
        },
      },
      async (manager) => {
        const players = manager.getRepository<Player>('Player');
        const player = await players.findOne({ where: { id: playerId }, lock });
        if (!player) throw new NotFoundException('Player not found');
        const previousStatus = player.status;
        if (previousStatus !== status)
          await players.update(player.id, { status });
        const revoked =
          status === PlayerStatus.ACTIVE
            ? []
            : await this.revokeSessions(manager, player.id);
        return {
          outcome: previousStatus === status ? 'UNCHANGED' : 'CHANGED',
          result: {
            previousStatus,
            status,
            revokedSessions: revoked.length,
          },
          metadata: { previousStatus, revokedSessions: revoked.length },
          after:
            status === PlayerStatus.ACTIVE
              ? undefined
              : () =>
                  this.sessionControl.playerAccountRevoked(player.id, revoked),
        };
      },
    );
  }
  private async revokeSessions(manager: EntityManager, playerId: string) {
    const result = await manager
      .getRepository<PlayerSession>('PlayerSession')
      .createQueryBuilder()
      .update()
      .set({ revokedAt: () => 'now()' })
      .where({ playerId, revokedAt: IsNull() })
      .returning(['id'])
      .execute();
    return (result.raw as { id: string }[]).map((row) => row.id);
  }

  // CREDIT or DEBIT of a positive amount, as one balanced STAFF_ADJUSTMENT
  // posting against the SYSTEM ADJUSTMENT account. The ledger keeps every
  // invariant (never below zero, balance ceiling, append-only). There is
  // no "set balance".
  adjustWallet(
    auth: AuthenticatedStaff,
    key: unknown,
    input: {
      gameServerId: string;
      characterExternalId: string;
      direction: EntryDirection;
      amount: number;
      externalReference: string;
      reason: string;
    },
  ) {
    const { gameServerId, characterExternalId, direction, amount } = input;
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.PLAYER_ECONOMY,
        action: OperatorActionKind.ADJUST,
        resourceId: characterExternalId,
        reason: input.reason,
        params: {
          gameServerId,
          direction,
          amount,
          externalReference: input.externalReference,
        },
        audit: {
          action: AuditAction.ECONOMY_STAFF_ADJUSTED,
          resourceType: AuditResource.ECONOMY_TRANSACTION,
        },
      },
      async (manager, actionId) => {
        // Only a wallet the backend already knows: a typo never creates one.
        const [known] = (await manager.query(
          `SELECT 1 FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2
           UNION ALL SELECT 1 FROM player_characters WHERE game_server_id = $1 AND character_external_id = $2
           LIMIT 1`,
          [gameServerId, characterExternalId],
        )) as unknown[];
        if (!known) throw new NotFoundException('Character wallet not found');
        const credit = direction === EntryDirection.CREDIT;
        let posted: { transactionId: string };
        try {
          posted = await this.ledger.postWithin(manager, {
            gameServerId,
            currency: Currency.GOLD,
            type: EconomyTransactionType.STAFF_ADJUSTMENT,
            actor: staffActor(auth.user),
            // One operator action, one posting.
            idempotencyKey: `operator-action:${actionId}`,
            reference: {
              type: STAFF_ADJUSTMENT_REFERENCE_TYPE,
              id: input.externalReference,
            },
            legs: [
              {
                account: {
                  ownerType: EconomyOwnerType.SYSTEM,
                  systemKey: SystemAccountKey.ADJUSTMENT,
                },
                amount: credit ? -amount : amount,
              },
              {
                account: {
                  ownerType: EconomyOwnerType.CHARACTER,
                  characterExternalId,
                },
                amount: credit ? amount : -amount,
              },
            ],
          });
        } catch (error) {
          if (error instanceof LedgerRejectionError)
            throw new ConflictException(
              `Adjustment rejected by the ledger: ${error.reason}`,
            );
          throw error;
        }
        const balance = await this.ledger.characterBalance(
          gameServerId,
          Currency.GOLD,
          characterExternalId,
          manager,
        );
        return {
          outcome: 'POSTED',
          result: {
            gameServerId,
            characterExternalId,
            direction,
            amount,
            transactionId: posted.transactionId,
            balance,
          },
          auditResourceId: posted.transactionId,
          metadata: {
            characterExternalId,
            transactionId: posted.transactionId,
            balance,
          },
        };
      },
    );
  }

  // Hides a message from every Player read; the content stays (evidence)
  // and nothing is deleted. Once per message.
  hideChatMessage(
    auth: AuthenticatedStaff,
    key: unknown,
    messageId: string,
    reason: string,
  ) {
    return this.actions.run(
      auth,
      key,
      {
        domain: OperatorDomain.PLAYER_CHAT,
        action: OperatorActionKind.HIDE,
        resourceId: messageId,
        reason,
        audit: {
          action: AuditAction.PLAYER_CHAT_MESSAGE_HIDDEN,
          resourceType: AuditResource.PLAYER_CHAT_MESSAGE,
        },
      },
      async (manager) => {
        const messages =
          manager.getRepository<PlayerChatMessage>('PlayerChatMessage');
        const message = await messages.findOne({
          where: { id: messageId },
          lock,
        });
        if (!message) throw new NotFoundException('Chat message not found');
        if (message.moderatedAt)
          throw new ConflictException('Chat message already hidden');
        const moderatedAt = new Date();
        await messages.update(
          { id: message.id, moderatedAt: IsNull() },
          {
            moderatedAt,
            moderatedByStaffId: auth.user.id,
            moderationReason: reason,
          },
        );
        return {
          outcome: 'HIDDEN',
          result: {
            gameServerId: message.gameServerId,
            channelType: message.channelType,
            moderatedAt: moderatedAt.toISOString(),
          },
          metadata: {
            gameServerId: message.gameServerId,
            channelType: message.channelType,
            senderCharacterId: message.senderCharacterId,
          },
        };
      },
    );
  }
}
