import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { uuid } from '../game-bridge/command-contract.js';
import { Player } from './entities/player.entity.js';
import { PlayerIdentity } from './entities/player-identity.entity.js';
import {
  identityProvider,
  playerDisplayName,
  PlayerStatus,
  providerSubject,
} from './player-account.contracts.js';
import type { IdentityProvider } from './player-account.contracts.js';

export interface IdentityInput {
  provider: IdentityProvider;
  providerSubject: string;
}

// Internal service for the future Player Authentication (10.3). No HTTP surface,
// no auth enforcement and no logging of provider subjects.
@Injectable()
export class PlayerAccountService {
  constructor(private readonly database: DataSource) {}
  // Creates the player and, optionally, its first identity atomically: an
  // identity already linked elsewhere rolls back the new player (409).
  async createPlayer(input: {
    displayName: string;
    identity?: IdentityInput;
  }): Promise<Player> {
    const displayName = playerDisplayName(input.displayName);
    const identity = input.identity && this.identity(input.identity);
    return this.database.transaction(async (manager) => {
      const id = randomUUID();
      await manager.getRepository<Player>('Player').insert({
        id,
        displayName,
        status: PlayerStatus.ACTIVE,
      });
      if (identity && !(await this.insertIdentity(manager, id, identity)))
        throw new ConflictException('Identity already linked');
      return manager.getRepository<Player>('Player').findOneByOrFail({ id });
    });
  }
  async findPlayerById(id: string): Promise<Player | null> {
    uuid(id);
    return this.database.getRepository<Player>('Player').findOneBy({ id });
  }
  async findByIdentity(
    provider: IdentityProvider,
    subject: string,
  ): Promise<Player | null> {
    const identity = this.identity({ provider, providerSubject: subject });
    return this.database
      .getRepository<Player>('Player')
      .createQueryBuilder('player')
      .innerJoin('PlayerIdentity', 'identity', 'identity.playerId = player.id')
      .where('identity.provider = :provider', { provider: identity.provider })
      .andWhere('identity.providerSubject = :subject', {
        subject: identity.providerSubject,
      })
      .getOne();
  }
  // Idempotent for the same player; an identity owned by another player is 409.
  async attachIdentity(
    playerId: string,
    input: IdentityInput,
  ): Promise<PlayerIdentity> {
    uuid(playerId);
    const identity = this.identity(input);
    return this.database.transaction(async (manager) => {
      const player = await manager.getRepository<Player>('Player').findOne({
        where: { id: playerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!player) throw new NotFoundException('Player not found');
      await this.insertIdentity(manager, playerId, identity);
      const stored = await manager
        .getRepository<PlayerIdentity>('PlayerIdentity')
        .findOneByOrFail({
          provider: identity.provider,
          providerSubject: identity.providerSubject,
        });
      if (stored.playerId !== playerId)
        throw new ConflictException('Identity already linked');
      return stored;
    });
  }
  private identity(input: IdentityInput): IdentityInput {
    return {
      provider: identityProvider(input?.provider),
      providerSubject: providerSubject(input?.providerSubject),
    };
  }
  // The unique constraint decides concurrent claims; DO NOTHING keeps the
  // transaction usable so the caller can report a conflict.
  private async insertIdentity(
    manager: EntityManager,
    playerId: string,
    identity: IdentityInput,
  ): Promise<boolean> {
    const result = await manager
      .getRepository<PlayerIdentity>('PlayerIdentity')
      .createQueryBuilder()
      .insert()
      .values({ id: randomUUID(), playerId, ...identity })
      .onConflict(
        'ON CONSTRAINT player_identities_provider_subject_key DO NOTHING',
      )
      .returning('id')
      .execute();
    return result.raw.length === 1;
  }
}
