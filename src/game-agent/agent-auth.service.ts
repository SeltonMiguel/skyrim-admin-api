import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameConnectionService } from '../game-bridge/game-connection.service.js';
import { GameServerService } from '../game-bridge/game-server.service.js';
import { GameConnection } from '../game-bridge/entities/game-connection.entity.js';
import {
  agentSecretHash,
  agentSecretMatches,
  AgentCredentialStatus,
} from './agent-credential.contracts.js';
import type { HelloPayload } from './agent-protocol.contracts.js';
import { GameAgentCredential } from './entities/game-agent-credential.entity.js';

// Internal reasons for logs and tests; the Agent only ever sees UNAUTHORIZED.
export type AgentAuthFailure =
  | 'UNKNOWN_SERVER'
  | 'UNKNOWN_CREDENTIAL'
  | 'CREDENTIAL_SERVER_MISMATCH'
  | 'CREDENTIAL_REVOKED'
  | 'INVALID_SECRET'
  | 'SERVER_DISABLED';
export class AgentAuthError extends Error {
  constructor(readonly reason: AgentAuthFailure) {
    super(reason);
  }
}
// A syntactically valid hash that matches no secret, compared when the
// credential does not exist so both paths do the same work.
const NO_MATCH = agentSecretHash('');

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerService,
    private readonly connections: GameConnectionService,
    private readonly clock: BridgeClock,
  ) {}
  // One short transaction, lock order game_servers -> credential ->
  // game_connections (the same as create/revoke). It verifies the HELLO,
  // creates the session row (closing the previous one as SUPERSEDED) and
  // stamps last_used_at. Nothing is published in memory here: a rollback
  // leaves no trace and never disturbs the previous session.
  // 12.5: also returns the session this HELLO superseded (possibly owned by
  // another replica), so its owner can be told to close the old socket.
  async authenticate(
    gameServerId: string,
    hello: HelloPayload,
  ): Promise<GameConnection & { supersededConnectionId?: string }> {
    return this.database.transaction(async (manager) => {
      const server = await this.servers
        .get(gameServerId, manager, true)
        .catch((error: unknown) => {
          if (error instanceof NotFoundException)
            throw new AgentAuthError('UNKNOWN_SERVER');
          throw error;
        });
      const credential = await manager
        .getRepository<GameAgentCredential>('GameAgentCredential')
        .findOne({
          where: { id: hello.credentialId },
          lock: { mode: 'pessimistic_write' },
        });
      const matches = agentSecretMatches(
        hello.credentialSecret,
        credential?.secretHash ?? NO_MATCH,
      );
      if (!credential) throw new AgentAuthError('UNKNOWN_CREDENTIAL');
      if (credential.gameServerId !== server.id)
        throw new AgentAuthError('CREDENTIAL_SERVER_MISMATCH');
      if (credential.status !== AgentCredentialStatus.ACTIVE)
        throw new AgentAuthError('CREDENTIAL_REVOKED');
      if (!matches) throw new AgentAuthError('INVALID_SECRET');
      if (!server.enabled) throw new AgentAuthError('SERVER_DISABLED');
      const previous = await this.connections.active(gameServerId, manager);
      // A fresh external id per socket: the Game Bridge never reuses one.
      const connection = await this.connections.connectInTransaction(manager, {
        gameServerId,
        externalConnectionId: randomUUID(),
        bridgeVersion: hello.agentVersion,
        agent: {
          credentialId: credential.id,
          capabilities: hello.capabilities,
          gameProcessState: hello.gameProcessState,
          skseReady: hello.skseReady,
        },
      });
      await manager
        .getRepository<GameAgentCredential>('GameAgentCredential')
        .update(credential.id, { lastUsedAt: this.clock.now() });
      return Object.assign(connection, {
        supersededConnectionId: previous?.id,
      });
    });
  }
  // Post-commit revalidation before a session becomes ACTIVE: the session
  // row is still the server's CONNECTED one (not superseded, revoked or
  // closed) and its credential is still ACTIVE. Never touches the secret.
  async eligible(
    connectionId: string,
  ): Promise<
    'ELIGIBLE' | 'CREDENTIAL_REVOKED' | 'SUPERSEDED' | 'SESSION_CLOSED'
  > {
    const connection = await this.database
      .getRepository<GameConnection>('GameConnection')
      .findOneBy({ id: connectionId });
    if (!connection?.credentialId || connection.status !== 'CONNECTED') {
      const reason = connection?.disconnectReason;
      return reason === 'CREDENTIAL_REVOKED' || reason === 'SUPERSEDED'
        ? reason
        : 'SESSION_CLOSED';
    }
    const credential = await this.database
      .getRepository<GameAgentCredential>('GameAgentCredential')
      .findOneBy({ id: connection.credentialId });
    return credential?.status === AgentCredentialStatus.ACTIVE
      ? 'ELIGIBLE'
      : 'CREDENTIAL_REVOKED';
  }
  // Whether a session row is still the active one (used to settle an old
  // in-memory session whose row a committed HELLO already superseded).
  async stillConnected(connectionId: string): Promise<boolean> {
    const connection = await this.database
      .getRepository<GameConnection>('GameConnection')
      .findOneBy({ id: connectionId });
    return connection?.status === 'CONNECTED';
  }
}
