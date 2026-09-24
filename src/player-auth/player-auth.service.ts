import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { playerActor } from '../actors/actor.contracts.js';
import { PlayerAccountService } from '../player-accounts/player-account.service.js';
import { PlayerStatus } from '../player-accounts/player-account.contracts.js';
import type { Player } from '../player-accounts/entities/player.entity.js';
import type { PlayerIdentity } from '../player-accounts/entities/player-identity.entity.js';
import { PlayerSession } from './entities/player-session.entity.js';
import { PlayerTokenService } from './player-token.service.js';
import type { PlayerTokenPair } from './player-token.service.js';
import type { ExternalIdentity } from './identity-provider.js';
import type { AuthenticatedPlayer } from './player-auth.types.js';
import type { PlayerMeDto } from './dto/player-auth.dto.js';

export type PlayerAuthResult = PlayerTokenPair & { player: PlayerMeDto };

// Player sessions mirror staff session rotation but share nothing with it.
// Login events are not written to Audit: the session row is the trail, and
// provider identifiers never enter Audit (see docs/player-services.md).
@Injectable()
export class PlayerAuthService {
  constructor(
    private readonly database: DataSource,
    private readonly accounts: PlayerAccountService,
    private readonly tokens: PlayerTokenService,
  ) {}
  // First valid login provisions the player and identity atomically (10.1);
  // concurrent first logins converge on the single winning player.
  async login(identity: ExternalIdentity): Promise<PlayerAuthResult> {
    const player = await this.provision(identity);
    return this.database.transaction(async (manager) => {
      const current = await this.lockActivePlayer(manager, player.id);
      const sessionId = randomUUID();
      const pair = await this.tokens.issue(current.id, sessionId);
      await manager.getRepository<PlayerSession>('PlayerSession').insert({
        id: sessionId,
        playerId: current.id,
        refreshTokenHash: this.tokens.hash(pair.refreshToken),
        expiresAt: pair.refreshExpiresAt,
      });
      return { ...pair, player: await this.me(current, manager) };
    });
  }
  // Rotation: the stored digest is replaced, so a previous refresh token
  // (including a replay of the one just used) no longer matches.
  async refresh(token: string): Promise<PlayerAuthResult> {
    const claims = await this.tokens.verify(token, 'refresh');
    return this.database.transaction(async (manager) => {
      // Lock order: player, then session (login, refresh and logout).
      const player = await this.lockActivePlayer(manager, claims.playerId);
      const sessions = manager.getRepository<PlayerSession>('PlayerSession');
      const session = await sessions
        .createQueryBuilder('session')
        .addSelect('session.refreshTokenHash')
        .where(
          'session.id = :sessionId AND session.playerId = :playerId',
          claims,
        )
        .setLock('pessimistic_write')
        .getOne();
      if (
        !this.active(session) ||
        !this.tokens.matches(token, session.refreshTokenHash)
      )
        throw invalidSession();
      const pair = await this.tokens.issue(
        player.id,
        session.id,
        session.expiresAt,
      );
      session.refreshTokenHash = this.tokens.hash(pair.refreshToken);
      session.lastUsedAt = new Date();
      await sessions.save(session);
      return { ...pair, player: await this.me(player, manager) };
    });
  }
  async authenticate(token: string): Promise<AuthenticatedPlayer> {
    const { playerId, sessionId } = await this.tokens.verify(token, 'access');
    const session = await this.database
      .getRepository<PlayerSession>('PlayerSession')
      .findOne({
        where: { id: sessionId, playerId },
        relations: { player: true },
      });
    if (!this.active(session)) throw invalidSession();
    requireActive(session.player);
    return {
      player: session.player,
      sessionId,
      actor: playerActor(session.player.id),
    };
  }
  async logout(auth: AuthenticatedPlayer): Promise<void> {
    await this.database.transaction(async (manager) => {
      await this.lockPlayer(manager, auth.player.id);
      await manager
        .getRepository<PlayerSession>('PlayerSession')
        .update(
          { id: auth.sessionId, playerId: auth.player.id, revokedAt: IsNull() },
          { revokedAt: new Date() },
        );
    });
  }
  // Identity summary only: providerSubject is never returned.
  async me(
    player: Player,
    manager: EntityManager = this.database.manager,
  ): Promise<PlayerMeDto> {
    const identities = await manager
      .getRepository<PlayerIdentity>('PlayerIdentity')
      .find({
        select: { provider: true, createdAt: true },
        where: { playerId: player.id },
        order: { createdAt: 'ASC', provider: 'ASC' },
      });
    return {
      id: player.id,
      displayName: player.displayName,
      status: player.status,
      identities: identities.map((identity) => ({
        provider: identity.provider,
        linkedAt: identity.createdAt,
      })),
    };
  }
  private async provision(identity: ExternalIdentity): Promise<Player> {
    const existing = await this.accounts.findByIdentity(
      identity.provider,
      identity.providerSubject,
    );
    if (existing) return existing;
    try {
      return await this.accounts.createPlayer({
        displayName: identity.displayName,
        identity: {
          provider: identity.provider,
          providerSubject: identity.providerSubject,
        },
      });
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      // Another first login won the UNIQUE(provider, subject) race.
      const winner = await this.accounts.findByIdentity(
        identity.provider,
        identity.providerSubject,
      );
      if (!winner) throw error;
      return winner;
    }
  }
  private lockPlayer(manager: EntityManager, id: string) {
    return manager
      .getRepository<Player>('Player')
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }
  private async lockActivePlayer(manager: EntityManager, id: string) {
    const player = await this.lockPlayer(manager, id);
    if (!player) throw invalidSession();
    requireActive(player);
    return player;
  }
  private active(session: PlayerSession | null): session is PlayerSession {
    return (
      !!session &&
      !session.revokedAt &&
      session.expiresAt.getTime() > Date.now()
    );
  }
}
// SUSPENDED and BANNED are blocked at login, refresh and on every request.
function requireActive(player: Player): void {
  if (player.status !== PlayerStatus.ACTIVE)
    throw new ForbiddenException('Player account unavailable');
}
const invalidSession = () =>
  new UnauthorizedException('Invalid or expired session');
