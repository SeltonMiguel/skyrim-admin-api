import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import {
  AuditAction,
  AuditOutcome,
  AuditResource,
} from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import { GameServerService } from '../game-bridge/game-server.service.js';
import { GameServerStatusNotifier } from '../game-bridge/game-server-status.notifier.js';
import {
  agentSecretHash,
  AgentCredentialStatus as S,
  generateAgentSecret,
  MAX_ACTIVE_AGENT_CREDENTIALS,
} from './agent-credential.contracts.js';
import { AgentSessionRegistry } from './agent-session.registry.js';
import type {
  AgentCredentialDto,
  CreatedAgentCredentialDto,
} from './dto/agent-credential.dto.js';
import { GameAgentCredential } from './entities/game-agent-credential.entity.js';
import { ClusterBus } from '../cluster/cluster-bus.js';

const NOT_FOUND = 'Agent credential not found';
const view = (credential: GameAgentCredential): AgentCredentialDto => ({
  credentialId: credential.id,
  gameServerId: credential.gameServerId,
  status: credential.status,
  createdAt: credential.createdAt,
  lastUsedAt: credential.lastUsedAt,
  revokedAt: credential.revokedAt,
});

// Staff management of Host Agent credentials. Lock order everywhere (HELLO
// included): game_servers row -> credential -> game_connections. The server
// row lock serializes creates, so "at most two ACTIVE" holds under
// concurrency without an in-memory mutex.
@Injectable()
export class AgentCredentialService {
  private readonly logger = new Logger(AgentCredentialService.name);
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerService,
    private readonly connections: GameConnectionService,
    private readonly audit: AuditService,
    private readonly sessions: AgentSessionRegistry,
    private readonly clock: BridgeClock,
    private readonly status: GameServerStatusNotifier,
    @Optional() private readonly cluster?: ClusterBus,
  ) {}
  private credentials(manager: EntityManager) {
    return manager.getRepository<GameAgentCredential>('GameAgentCredential');
  }
  async list(gameServerId: string): Promise<AgentCredentialDto[]> {
    await this.servers.get(gameServerId);
    const rows = await this.credentials(this.database.manager).find({
      where: { gameServerId },
      order: { createdAt: 'DESC', id: 'ASC' },
    });
    return rows.map(view);
  }
  // Not idempotent by design: every call issues a new secret, bounded by the
  // ACTIVE limit. A lost response is recovered by revoking and re-creating.
  async create(
    gameServerId: string,
    auth: AuthenticatedStaff,
  ): Promise<CreatedAgentCredentialDto> {
    const secret = generateAgentSecret();
    const credential = await this.database.transaction(async (manager) => {
      await this.servers.get(gameServerId, manager, true);
      const active = await this.credentials(manager).countBy({
        gameServerId,
        status: S.ACTIVE,
      });
      if (active >= MAX_ACTIVE_AGENT_CREDENTIALS)
        throw new ConflictException(
          'Game server already has the maximum of active Agent credentials',
        );
      const id = randomUUID();
      await this.credentials(manager).insert({
        id,
        gameServerId,
        secretHash: agentSecretHash(secret),
        status: S.ACTIVE,
        createdByStaffId: auth.user.id,
        createdAt: this.clock.now(),
      });
      const saved = await this.credentials(manager).findOneByOrFail({ id });
      await this.record(
        manager,
        auth,
        AuditAction.GAME_AGENT_CREDENTIAL_CREATED,
        saved,
        201,
      );
      return saved;
    });
    this.logger.log(
      `Agent credential created [gameServerId=${gameServerId} credentialId=${credential.id}]`,
    );
    return {
      credentialId: credential.id,
      gameServerId: credential.gameServerId,
      credentialSecret: secret,
      status: S.ACTIVE,
      createdAt: credential.createdAt,
    };
  }
  // ACTIVE -> REVOKED once; revoking again returns the credential unchanged,
  // without Audit. The sessions it authenticated are closed in the database
  // in the same transaction and their sockets right after commit.
  async revoke(
    gameServerId: string,
    credentialId: string,
    auth: AuthenticatedStaff,
  ): Promise<AgentCredentialDto> {
    const { credential, revoked } = await this.database.transaction(
      async (manager) => {
        await this.servers.get(gameServerId, manager, true);
        const credential = await this.credentials(manager).findOne({
          where: { id: credentialId, gameServerId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!credential) throw new NotFoundException(NOT_FOUND);
        if (credential.status === S.REVOKED)
          return { credential, revoked: false };
        await this.credentials(manager).update(credential.id, {
          status: S.REVOKED,
          revokedAt: this.clock.now(),
        });
        await this.connections.endByCredential(manager, credential.id);
        const saved = await this.credentials(manager).findOneByOrFail({
          id: credential.id,
        });
        await this.record(
          manager,
          auth,
          AuditAction.GAME_AGENT_CREDENTIAL_REVOKED,
          saved,
          200,
        );
        return { credential: saved, revoked: true };
      },
    );
    if (revoked) {
      // 12.5: sockets on other replicas close too. If this signal is lost,
      // the rows closed above already fence every frame of those sockets.
      void this.cluster?.publish('AGENT_CREDENTIAL_REVOKED', {
        credentialId: credential.id,
      });
      for (const session of this.sessions.byCredential(credential.id)) {
        this.sessions.terminate(
          session.gameServerId,
          session.connectionId,
          'CREDENTIAL_REVOKED',
        );
        this.logger.warn(
          `Agent session closed: credential revoked [gameServerId=${session.gameServerId} connectionId=${session.connectionId} credentialId=${credential.id}]`,
        );
      }
      this.logger.log(
        `Agent credential revoked [gameServerId=${gameServerId} credentialId=${credential.id}]`,
      );
      // Covers a closed row without a live socket in this instance.
      void this.status.changed(gameServerId);
    }
    return view(credential);
  }
  // Metadata allowlist: never the secret or its hash. The credential id is
  // the Audit resourceId; the Audit sanitizer drops any metadata key that
  // mentions a credential by design, so it is not repeated there.
  private record(
    manager: EntityManager,
    auth: AuthenticatedStaff,
    action: AuditAction,
    credential: GameAgentCredential,
    statusCode: number,
  ) {
    return this.audit.record(
      {
        actor: {
          id: auth.user.id,
          username: auth.user.username,
          displayName: auth.user.displayName,
          roleName: auth.user.roleName,
        },
        action,
        resourceType: AuditResource.GAME_AGENT_CREDENTIAL,
        resourceId: credential.id,
        metadata: {
          gameServerId: credential.gameServerId,
          status: credential.status,
        },
        outcome: AuditOutcome.SUCCESS,
        statusCode,
      },
      manager,
    );
  }
}
