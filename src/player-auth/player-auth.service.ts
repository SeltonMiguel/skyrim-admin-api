import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { playerActor } from '../actors/actor.contracts.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import type { ApplicationConfig } from '../config/environment.js';
import { RealtimeSessionControl } from '../realtime-events/realtime-session-control.js';
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
    private readonly audit: AuditService,
    config: ConfigService<{ application: ApplicationConfig }, true>,
    private readonly realtime: RealtimeSessionControl,
  ) {
    this.reuseGraceMs = config.get('application', {
      infer: true,
    }).security.refreshReuseGraceMs;
  }
  private readonly reuseGraceMs: number;
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
  // Rotation: the stored digest is replaced, so a previous refresh token no
  // longer matches. Reuse detection (12.1), same model as Staff: a validly
  // signed refresh token of this session that is not the current one was
  // rotated away. Within the grace window after the last rotation it is a
  // concurrent refresh that lost the race (401, session kept); after it, a
  // replay: this session only is revoked and the event is audited (the
  // Player's other sessions are untouched).
  async refresh(token: string): Promise<PlayerAuthResult> {
    const claims = await this.tokens.verify(token, 'refresh');
    const outcome = await this.database.transaction(async (manager) => {
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
      if (!this.active(session)) throw invalidSession();
      if (!this.tokens.matches(token, session.refreshTokenHash)) {
        const now = Date.now();
        if (
          session.lastUsedAt &&
          now - session.lastUsedAt.getTime() <= this.reuseGraceMs
        )
          return { kind: 'STALE' as const };
        session.revokedAt = new Date(now);
        await sessions.save(session);
        await this.audit.record(
          {
            actor: playerActor(player.id),
            action: AuditAction.PLAYER_AUTH_REFRESH_REUSE_DETECTED,
            resourceType: AuditResource.PLAYER_SESSION,
            resourceId: session.id,
            outcome: AuditOutcome.SUCCESS,
            statusCode: 401,
          },
          manager,
        );
        return { kind: 'REVOKED' as const, sessionId: session.id };
      }
      const pair = await this.tokens.issue(
        player.id,
        session.id,
        session.expiresAt,
      );
      session.refreshTokenHash = this.tokens.hash(pair.refreshToken);
      // Same clock as the reuse grace check above.
      session.lastUsedAt = new Date(Date.now());
      await sessions.save(session);
      return {
        kind: 'ROTATED' as const,
        value: { ...pair, player: await this.me(player, manager) },
      };
    });
    if (outcome.kind === 'ROTATED') return outcome.value;
    // After commit: the revoked session's realtime sockets close too.
    if (outcome.kind === 'REVOKED')
      this.realtime.playerSessionRevoked(outcome.sessionId);
    throw invalidSession();
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
  // Revokes only this session; after commit its realtime sockets close
  // (other sessions of the account stay connected).
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
    this.realtime.playerSessionRevoked(auth.sessionId);
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
