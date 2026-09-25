import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import { RequestContext } from '../../src/common/request-context/request-context.service.js';
import type { ApplicationConfig } from '../../src/config/environment.js';
import { validateEnvironment } from '../../src/config/environment.js';
import { GameCommand } from '../../src/game-bridge/entities/game-command.entity.js';
import { GameCommandResult } from '../../src/game-bridge/entities/game-command-result.entity.js';
import { GameConnection } from '../../src/game-bridge/entities/game-connection.entity.js';
import { GameServer } from '../../src/game-bridge/entities/game-server.entity.js';
import { GameCommandBus } from '../../src/game-bridge/game-command-bus.js';
import { GameCommandStore } from '../../src/game-bridge/game-command-store.js';
import { GameCommandDispatcher } from '../../src/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../../src/game-bridge/game-command-receiver.js';
import { GameConnectionService } from '../../src/game-bridge/game-connection.service.js';
import { GameServerService } from '../../src/game-bridge/game-server.service.js';
import { CommandStatus as S } from '../../src/game-bridge/command-state.js';
import { MockGameGateway, TestBridgeClock } from './mock-game-gateway.js';

// Small repository substitute for service behavior only; PostgreSQL tests own
// the concurrency, transaction rollback and constraint guarantees.
export function gameFixture() {
  const clock = new TestBridgeClock();
  const server = Object.assign(new GameServer(), {
    id: randomUUID(),
    enabled: true,
  });
  const connection = Object.assign(new GameConnection(), {
    id: randomUUID(),
    gameServerId: server.id,
    externalConnectionId: 'connection',
    status: 'CONNECTED',
    lastHeartbeatAt: clock.now(),
    disconnectedAt: null,
  });
  const command: GameCommand = Object.assign(new GameCommand(), {
    id: randomUUID(),
    gameServerId: server.id,
    type: 'BRIDGE_PING',
    payload: { nonce: 'ping' },
    idempotencyKey: 'key',
    // PostgreSQL defaults for rows without an explicit actor.
    idempotencyScope: 'STAFF',
    actorType: 'STAFF',
    correlationId: randomUUID(),
    status: S.PENDING,
    dispatchAttempts: 0,
    dispatchLeaseId: null,
    dispatchLeaseExpiresAt: null,
    dispatchedConnectionId: null,
    createdAt: clock.now(),
    ackDeadlineAt: null,
    executionDeadlineAt: null,
    acknowledgedAt: null,
    completedAt: null,
  });
  const rows: Record<string, object[]> = {
    GameServer: [server],
    GameConnection: [connection],
    GameCommand: [command],
    GameCommandResult: [],
  };
  function repository(name: string) {
    const matches = (row: object, where: object) =>
      Object.entries(where).every(
        ([key, value]) => (row as Record<string, unknown>)[key] === value,
      );
    return {
      create: (value: object) => value,
      save: async (value: object) => {
        if (!rows[name].includes(value)) rows[name].push(value);
        return value;
      },
      insert: async (value: object) => {
        rows[name].push(value);
      },
      findOne: async ({ where }: { where: object }) =>
        rows[name].find((row) => matches(row, where)) ?? null,
      findOneBy: async (where: object) =>
        rows[name].find((row) => matches(row, where)) ?? null,
      findOneByOrFail: async (where: object) => {
        const row = rows[name].find((row) => matches(row, where));
        if (!row) throw new Error('Missing test row');
        return row;
      },
      update: async (where: object, value: object) => {
        rows[name]
          .filter((row) => matches(row, where))
          .forEach((row) => Object.assign(row, value));
      },
      createQueryBuilder: () => {
        let value: object;
        const builder = {
          insert: () => builder,
          values: (input: object) => {
            value = input;
            return builder;
          },
          onConflict: () => builder,
          execute: async () => {
            const input = value as GameCommand;
            if (
              !rows[name].some((row) =>
                matches(row, {
                  gameServerId: input.gameServerId,
                  idempotencyScope: input.idempotencyScope,
                  idempotencyKey: input.idempotencyKey,
                }),
              )
            )
              rows[name].push(value);
          },
          where: () => builder,
          andWhere: () => builder,
          orderBy: () => builder,
          addOrderBy: () => builder,
          take: () => builder,
          getMany: async () => rows[name],
        };
        return builder;
      },
    };
  }
  const manager = { getRepository: repository } as unknown as EntityManager;
  const database = {
    manager,
    getRepository: repository,
    transaction: async <T>(fn: (manager: EntityManager) => Promise<T>) =>
      fn(manager),
  } as unknown as DataSource;
  const config = new ConfigService<{ application: ApplicationConfig }, true>({
    application: validateEnvironment({
      NODE_ENV: 'test',
      DB_HOST: 'local',
      DB_USERNAME: 'test',
      DB_PASSWORD: 'test',
      DB_DATABASE: 'test',
      GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS: 120000,
    }),
  });
  const servers = new GameServerService(database);
  const connections = new GameConnectionService(
    database,
    servers,
    clock,
    config,
  );
  const store = new GameCommandStore(database, servers, clock);
  const gateway = new MockGameGateway();
  const context = new RequestContext();
  const bus = new GameCommandBus(database, servers, context, clock);
  const dispatcher = new GameCommandDispatcher(
    database,
    store,
    connections,
    gateway,
    clock,
    config,
  );
  const receiver = new GameCommandReceiver(
    database,
    store,
    connections,
    clock,
    config,
  );
  const ack = () => ({
    protocolVersion: '1' as const,
    commandId: command.id,
    correlationId: command.correlationId,
    serverId: server.id,
    connectionId: connection.id,
  });
  return {
    command,
    connection,
    server,
    clock,
    gateway,
    connections,
    bus,
    dispatcher,
    receiver,
    context,
    ack,
    rows,
    results: () => rows.GameCommandResult as GameCommandResult[],
    success: () => ({
      ...ack(),
      outcome: S.SUCCEEDED as const,
      result: { nonce: 'ping' },
    }),
  };
}
