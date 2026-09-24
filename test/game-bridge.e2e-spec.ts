import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import {
  MockGameGateway,
  TestBridgeClock,
} from './support/mock-game-gateway.js';
import { loadEnvironment } from '../src/config/environment.js';
import type { ApplicationConfig } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { RequestContext } from '../src/common/request-context/request-context.service.js';
import { GameBridgeModule } from '../src/game-bridge/game-bridge.module.js';
import { GameCommandBus } from '../src/game-bridge/game-command-bus.js';
import { GameCommandStore } from '../src/game-bridge/game-command-store.js';
import { GameCommandDispatcher } from '../src/game-bridge/game-command-dispatcher.js';
import { GameCommandReceiver } from '../src/game-bridge/game-command-receiver.js';
import { GameConnectionService } from '../src/game-bridge/game-connection.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import { GameConnection } from '../src/game-bridge/entities/game-connection.entity.js';
import { GameCommandResult } from '../src/game-bridge/entities/game-command-result.entity.js';
import {
  GameGateway,
  DisconnectedGameGateway,
} from '../src/game-bridge/game-gateway.js';
import { BridgeClock } from '../src/game-bridge/bridge-clock.js';
import { CommandStatus as S } from '../src/game-bridge/command-state.js';
import type {
  BridgeMessage,
  ResultMessage,
} from '../src/game-bridge/command-contract.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase('Game Bridge with real PostgreSQL', () => {
  let admin: DataSource, database: DataSource, module: TestingModule;
  let bus: GameCommandBus,
    dispatcher: GameCommandDispatcher,
    receiver: GameCommandReceiver;
  let connections: GameConnectionService,
    servers: GameServerService,
    context: RequestContext;
  let gateway: MockGameGateway, clock: TestBridgeClock;
  let serverId: string, connection: GameConnection;
  const schema = `bridge_test_${randomUUID().replaceAll('-', '')}`;
  const commands = () => database.getRepository<GameCommand>('GameCommand');
  const results = () =>
    database.getRepository<GameCommandResult>('GameCommandResult');
  const create = (key = randomUUID(), nonce = 'ping') =>
    bus.submit({
      gameServerId: serverId,
      type: 'BRIDGE_PING',
      payload: { nonce },
      idempotencyKey: key,
    });
  const read = (id: string) => commands().findOneByOrFail({ id });
  const ack = (command: GameCommand): BridgeMessage => ({
    protocolVersion: '1',
    commandId: command.id,
    correlationId: command.correlationId,
    serverId: command.gameServerId,
    connectionId: command.dispatchedConnectionId ?? connection.id,
  });
  const success = (command: GameCommand): ResultMessage => ({
    ...ack(command),
    outcome: S.SUCCEEDED,
    result: { nonce: 'ping' },
  });
  const dispatched = async () => dispatcher.dispatch((await create()).id);
  beforeAll(async () => {
    const config = loadEnvironment();
    const options = createDatabaseOptions(config);
    if (options.type !== 'postgres') throw new Error('PostgreSQL required');
    admin = new DataSource(options);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    database = new DataSource({
      ...options,
      schema,
      ...(await compiledDatabaseArtifacts()),
      extra: { ...options.extra, options: `-c search_path=${schema},public` },
    });
    await database.initialize();
    expect(await database.runMigrations()).toHaveLength(7);
    await database.undoLastMigration(); // Etapa 07 World permission grants
    await database.undoLastMigration(); // Etapa 05 result size constraint
    await database.undoLastMigration(); // Etapa 04 permission grants
    await database.undoLastMigration();
    expect(
      await database.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'game_commands' AND column_name LIKE 'dispatch_lease_%'",
        [schema],
      ),
    ).toEqual([]);
    await database.undoLastMigration();
    expect(
      await database.query(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE $2',
        [schema, 'game_%'],
      ),
    ).toEqual([]);
    expect(await database.runMigrations()).toHaveLength(5);
    expect(await database.runMigrations()).toHaveLength(0);
    gateway = new MockGameGateway();
    clock = new TestBridgeClock();
    module = await Test.createTestingModule({ imports: [GameBridgeModule] })
      .useMocker((token) => {
        if (token === DataSource) return database;
        if (token === ConfigService)
          return new ConfigService({
            application: {
              ...config,
              gameBridge: {
                ...config.gameBridge,
                heartbeatTimeoutMs: 120000,
                ackTimeoutMs: 5000,
                executionTimeoutMs: 30000,
                maxDispatchAttempts: 3,
              },
            } satisfies ApplicationConfig,
          });
        return undefined;
      })
      .overrideProvider(GameGateway)
      .useValue(gateway)
      .overrideProvider(BridgeClock)
      .useValue(clock)
      .compile();
    bus = module.get(GameCommandBus);
    dispatcher = module.get(GameCommandDispatcher);
    receiver = module.get(GameCommandReceiver);
    connections = module.get(GameConnectionService);
    servers = module.get(GameServerService);
    context = module.get(RequestContext);
  }, 30000);
  beforeEach(async () => {
    gateway.sends = [];
    gateway.responses = [];
    gateway.available = true;
    gateway.beforeSend = undefined;
    serverId = (
      await servers.register({ code: randomUUID(), name: 'Test server' })
    ).id;
    connection = await connections.connect({
      gameServerId: serverId,
      externalConnectionId: randomUUID(),
      bridgeVersion: 'test-1',
    });
  });
  afterAll(async () => {
    await module?.close();
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('migrates four tables, rolls back/reapplies and matches all entity metadata', async () => {
    expect(database.options.synchronize).toBe(false);
    expect(
      (await database.driver.createSchemaBuilder().log()).upQueries,
    ).toEqual([]);
    expect(
      await database.query(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE $2',
        [schema, 'game_%'],
      ),
    ).toHaveLength(4);
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(7);
  });
  it('registers and locates servers and rejects duplicate code through the database', async () => {
    expect(await servers.get(serverId)).toMatchObject({ enabled: true });
    const input = { code: randomUUID(), name: 'Unique' };
    const outcomes = await Promise.allSettled([
      servers.register(input),
      servers.register(input),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(
      database.query('INSERT INTO game_servers(code, name) VALUES ($1, $2)', [
        input.code,
        'Duplicate',
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });
  it('persists connection metadata and idempotently repeats an active connect', async () => {
    expect(connection).toMatchObject({
      status: 'CONNECTED',
      bridgeVersion: 'test-1',
      protocolVersion: '1',
      disconnectedAt: null,
    });
    expect(
      (
        await connections.connect({
          gameServerId: serverId,
          externalConnectionId: connection.externalConnectionId,
        })
      ).id,
    ).toBe(connection.id);
    expect(await connections.isConnectionHealthy(serverId)).toBe(true);
  });
  it('supersedes connections transactionally and preserves history', async () => {
    const next = await connections.connect({
      gameServerId: serverId,
      externalConnectionId: randomUUID(),
    });
    expect(next.id).not.toBe(connection.id);
    expect(
      await database
        .getRepository<GameConnection>('GameConnection')
        .findOneByOrFail({ id: connection.id }),
    ).toMatchObject({ status: 'DISCONNECTED', disconnectReason: 'SUPERSEDED' });
    expect(await connections.heartbeat(serverId, connection.id)).toBe(false);
    await expect(
      connections.connect({
        gameServerId: serverId,
        externalConnectionId: connection.externalConnectionId,
      }),
    ).rejects.toThrow('cannot be reused');
  });
  it('updates only the matching heartbeat and disconnects idempotently', async () => {
    clock.advance(1000);
    expect(await connections.heartbeat(serverId, randomUUID())).toBe(false);
    expect(await connections.heartbeat(serverId, connection.id)).toBe(true);
    expect((await connections.active(serverId))?.lastHeartbeatAt).toEqual(
      clock.now(),
    );
    expect(await connections.disconnect(serverId, connection.id)).toBe(true);
    expect(await connections.disconnect(serverId, connection.id)).toBe(false);
    expect(await connections.isConnectionHealthy(serverId)).toBe(false);
  });
  it('marks stale connections and never revives them with heartbeat', async () => {
    clock.advance(120000);
    expect(await connections.isConnectionHealthy(serverId)).toBe(false);
    await connections.markStaleConnections();
    expect(await connections.active(serverId)).toBeNull();
    expect(await connections.heartbeat(serverId, connection.id)).toBe(false);
  });
  it('rejects an expired heartbeat even before stale sweeping', async () => {
    clock.advance(120000);
    expect(await connections.heartbeat(serverId, connection.id)).toBe(false);
    expect(await connections.active(serverId)).toBeNull();
  });
  it('serializes new connections against old heartbeats and concurrent connects', async () => {
    const old = connection.id;
    const values = await Promise.all([
      connections.connect({
        gameServerId: serverId,
        externalConnectionId: randomUUID(),
      }),
      connections.heartbeat(serverId, old),
      connections.connect({
        gameServerId: serverId,
        externalConnectionId: randomUUID(),
      }),
    ]);
    expect(values).toHaveLength(3);
    expect((await connections.active(serverId))?.id).not.toBe(old);
    expect(
      await database
        .getRepository<GameConnection>('GameConnection')
        .countBy({ gameServerId: serverId, status: 'CONNECTED' }),
    ).toBe(1);
    expect(await connections.heartbeat(serverId, old)).toBe(false);
  });
  it('enforces one active connection in direct SQL', async () => {
    await expect(
      database.query(
        "INSERT INTO game_connections(game_server_id, external_connection_id, status, connected_at, last_heartbeat_at) VALUES ($1, $2, 'CONNECTED', now(), now())",
        [serverId, randomUUID()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });
  it('creates PENDING with separate correlationId and no invented request ID', async () => {
    const command = await create();
    expect(command).toMatchObject({
      type: 'BRIDGE_PING',
      status: S.PENDING,
      payload: { nonce: 'ping' },
      requestId: null,
      dispatchAttempts: 0,
      requestedByStaffId: null,
    });
    expect(command.correlationId).not.toBe(command.id);
  });
  it('preserves request context across concurrent submissions and creates no AuditLog', async () => {
    const submissions = Array.from(
      { length: 6 },
      (_, index) =>
        new Promise<GameCommand>((resolve, reject) =>
          context.run(`bridge-request-${index}`, () => {
            void create().then(resolve, reject);
          }),
        ),
    );
    const list = await Promise.all(submissions);
    list.forEach((command, index) => {
      expect(command.requestId).toBe(`bridge-request-${index}`);
      expect(command.correlationId).not.toBe(command.requestId);
    });
    const sent = await dispatcher.dispatch(list[0].id);
    await receiver.result(success(sent));
    expect(await database.query('SELECT * FROM audit_logs')).toEqual([]);
  });
  it('returns the same command for concurrent identical keys and payloads', async () => {
    const key = randomUUID();
    const list = await Promise.all(
      Array.from({ length: 8 }, () => create(key)),
    );
    expect(new Set(list.map((command) => command.id)).size).toBe(1);
    expect(
      await commands().countBy({ gameServerId: serverId, idempotencyKey: key }),
    ).toBe(1);
    expect((await create(key)).id).toBe(list[0].id);
  });
  it('rejects a conflicting payload without a second command', async () => {
    const key = randomUUID();
    const list = await Promise.allSettled([create(key, 'a'), create(key, 'b')]);
    expect(list.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(list.filter((result) => result.status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      await commands().countBy({ gameServerId: serverId, idempotencyKey: key }),
    ).toBe(1);
  });
  it('enforces idempotency in SQL and scopes it per server', async () => {
    const command = await create();
    await expect(
      database.query(
        'INSERT INTO game_commands(game_server_id, type, payload, idempotency_key, correlation_id) VALUES ($1, $2, $3, $4, $5)',
        [
          serverId,
          'BRIDGE_PING',
          { nonce: 'ping' },
          command.idempotencyKey,
          randomUUID(),
        ],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
    const other = await servers.register({ code: randomUUID(), name: 'Other' });
    expect(
      (
        await bus.submit({
          gameServerId: other.id,
          type: 'BRIDGE_PING',
          payload: { nonce: 'ping' },
          idempotencyKey: command.idempotencyKey,
        })
      ).id,
    ).not.toBe(command.id);
  });
  it('dispatches an envelope without implying ACK or completion', async () => {
    const command = await dispatched();
    expect(command).toMatchObject({
      status: S.DISPATCHED,
      dispatchAttempts: 1,
      acknowledgedAt: null,
      completedAt: null,
    });
    expect(gateway.sends[0].envelope).toMatchObject({
      protocolVersion: '1',
      commandId: command.id,
      serverId,
      connectionId: connection.id,
      correlationId: command.correlationId,
      type: 'BRIDGE_PING',
      payload: { nonce: 'ping' },
    });
    expect(gateway.sends[0].envelope).not.toHaveProperty('status');
    expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
  });
  it('serializes two dispatchers so they send only once', async () => {
    const command = await create();
    const values = await Promise.all([
      dispatcher.dispatch(command.id),
      dispatcher.dispatch(command.id),
    ]);
    expect(
      values.every((value) => [S.PENDING, S.DISPATCHED].includes(value.status)),
    ).toBe(true);
    expect(gateway.sends).toHaveLength(1);
    expect((await read(command.id)).dispatchAttempts).toBe(1);
  });
  it('processes ACK and duplicate concurrent ACK idempotently', async () => {
    const command = await dispatched();
    const list = await Promise.all([
      receiver.acknowledge(ack(command)),
      receiver.acknowledge(ack(command)),
    ]);
    expect(list.map((value) => value.status)).toEqual([
      S.ACKNOWLEDGED,
      S.ACKNOWLEDGED,
    ]);
    const first = list[0].acknowledgedAt;
    clock.advance(100);
    expect((await receiver.acknowledge(ack(command))).acknowledgedAt).toEqual(
      first,
    );
  });
  it('accepts success after ACK and inserts exactly one terminal result', async () => {
    const command = await dispatched();
    await receiver.acknowledge(ack(command));
    expect((await receiver.result(success(command))).status).toBe(S.SUCCEEDED);
    expect(
      await results().findOneByOrFail({ gameCommandId: command.id }),
    ).toMatchObject({
      outcome: S.SUCCEEDED,
      result: { nonce: 'ping' },
      errorCode: null,
    });
  });
  it('accepts failure without retaining arbitrary remote stack traces', async () => {
    const command = await dispatched();
    const message = {
      ...ack(command),
      outcome: S.FAILED as const,
      errorCode: 'BRIDGE_ERROR' as const,
      errorMessage: 'remote secret\n at private stack',
    };
    expect((await receiver.result(message)).status).toBe(S.FAILED);
    expect(
      await results().findOneByOrFail({ gameCommandId: command.id }),
    ).toMatchObject({
      result: null,
      errorCode: 'BRIDGE_ERROR',
      errorMessage: 'Bridge reported failure',
    });
  });
  it('infers ACK for RESULT before ACK atomically', async () => {
    const command = await dispatched();
    const done = await receiver.result(success(command));
    expect(done.status).toBe(S.SUCCEEDED);
    expect(done.acknowledgedAt).toEqual(done.completedAt);
    expect((await receiver.acknowledge(ack(command))).status).toBe(S.SUCCEEDED);
  });
  it('deduplicates concurrent identical results and protects the unique result constraint', async () => {
    const command = await dispatched();
    const list = await Promise.all([
      receiver.result(success(command)),
      receiver.result(success(command)),
    ]);
    expect(list.every((value) => value.status === S.SUCCEEDED)).toBe(true);
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
    await expect(
      database.query(
        "INSERT INTO game_command_results(game_command_id, outcome, received_at) VALUES ($1, 'FAILED', now())",
        [command.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });
  it('rejects conflicting terminal results and never redispatches terminal commands', async () => {
    const command = await dispatched();
    await receiver.result(success(command));
    await expect(
      receiver.result({
        ...ack(command),
        outcome: S.FAILED,
        errorCode: 'PING_REJECTED',
      }),
    ).rejects.toThrow('another result');
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    expect(gateway.sends).toHaveLength(1);
    expect((await read(command.id)).status).toBe(S.SUCCEEDED);
  });
  it.each(['correlationId', 'serverId', 'connectionId'] as const)(
    'rejects wrong %s for ACK and RESULT',
    async (field) => {
      const command = await dispatched();
      await expect(
        receiver.acknowledge({ ...ack(command), [field]: randomUUID() }),
      ).rejects.toThrow('does not match');
      await expect(
        receiver.result({ ...success(command), [field]: randomUUID() }),
      ).rejects.toThrow('does not match');
      expect((await read(command.id)).status).toBe(S.DISPATCHED);
    },
  );
  it('rejects wrong protocol, nonce, malformed/large payloads and unsupported types', async () => {
    const command = await dispatched();
    await expect(
      receiver.acknowledge({
        ...ack(command),
        protocolVersion: '2',
      } as unknown as BridgeMessage),
    ).rejects.toThrow('protocol');
    await expect(
      receiver.result({
        ...ack(command),
        outcome: S.SUCCEEDED,
        result: { nonce: 'wrong' },
      }),
    ).rejects.toThrow('nonce');
    await expect(create(randomUUID(), 'x'.repeat(5000))).rejects.toThrow();
    await expect(
      bus.submit({
        gameServerId: serverId,
        type: 'CONSOLE',
        payload: { nonce: 'x' },
        idempotencyKey: randomUUID(),
      } as unknown as Parameters<GameCommandBus['submit']>[0]),
    ).rejects.toThrow('Unsupported');
  });
  it('rejects messages from a superseded connection and allows retry to the new connection', async () => {
    const command = await dispatched();
    const next = await connections.connect({
      gameServerId: serverId,
      externalConnectionId: randomUUID(),
    });
    await expect(receiver.result(success(command))).rejects.toThrow(
      'no longer active',
    );
    clock.advance(5000);
    const retried = await dispatcher.dispatch(command.id);
    expect(retried.dispatchedConnectionId).toBe(next.id);
    await expect(receiver.acknowledge(ack(command))).rejects.toThrow(
      'does not match',
    );
    expect((await receiver.result(success(retried))).status).toBe(S.SUCCEEDED);
  });
  it('retries ACK timeout with identical logical identifiers and a fixed execution deadline', async () => {
    const command = await dispatched();
    clock.advance(4999);
    await dispatcher.dispatch(command.id);
    expect(gateway.sends).toHaveLength(1);
    clock.advance(1);
    await dispatcher.retryTimedOutDispatches();
    const retry = await read(command.id);
    expect(retry).toMatchObject({
      status: S.DISPATCHED,
      dispatchAttempts: 2,
      id: command.id,
      correlationId: command.correlationId,
      idempotencyKey: command.idempotencyKey,
      executionDeadlineAt: command.executionDeadlineAt,
    });
    expect(
      gateway.sends.filter((send) => send.envelope.commandId === command.id),
    ).toHaveLength(2);
  });
  it('waits the final ACK window then records TIMEOUT after max attempts', async () => {
    const command = await dispatched();
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.DISPATCHED);
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.TIMEOUT);
    expect((await read(command.id)).dispatchAttempts).toBe(3);
    expect(
      await results().findOneByOrFail({ gameCommandId: command.id }),
    ).toMatchObject({ outcome: S.TIMEOUT, errorCode: 'ACK_TIMEOUT' });
  });
  it('expires final ACK without retry scheduling and treats a late ACK as terminal', async () => {
    const command = await dispatched();
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    clock.advance(5000);
    await receiver.expireCommands();
    expect((await receiver.acknowledge(ack(command))).status).toBe(S.TIMEOUT);
  });
  it('expires execution and rejects a result arriving after TIMEOUT', async () => {
    const command = await dispatched();
    await receiver.acknowledge(ack(command));
    clock.advance(30000);
    await receiver.expireCommands();
    expect((await read(command.id)).status).toBe(S.TIMEOUT);
    await expect(receiver.result(success(command))).rejects.toThrow(
      'another result',
    );
    expect(
      await results().findOneByOrFail({ gameCommandId: command.id }),
    ).toMatchObject({ outcome: S.TIMEOUT, errorCode: 'EXECUTION_TIMEOUT' });
  });
  it('enforces deadline in RESULT even if the expiration worker has not run', async () => {
    const command = await dispatched();
    await receiver.acknowledge(ack(command));
    clock.advance(30000);
    expect((await receiver.result(success(command))).status).toBe(S.TIMEOUT);
  });
  it('bounds missing ACK by the original execution deadline even before exhausting attempts', async () => {
    const command = await dispatched();
    clock.advance(30000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.TIMEOUT);
    expect((await read(command.id)).dispatchAttempts).toBe(1);
  });
  it.each([29999, 30000])(
    'serializes timeout versus RESULT at elapsed %i deterministically',
    async (elapsed) => {
      const command = await dispatched();
      await receiver.acknowledge(ack(command));
      clock.advance(elapsed);
      await Promise.allSettled([
        receiver.expireCommands(),
        receiver.result(success(command)),
      ]);
      const expected = elapsed < 30000 ? S.SUCCEEDED : S.TIMEOUT;
      expect((await read(command.id)).status).toBe(expected);
      expect(
        await results().findBy({ gameCommandId: command.id }),
      ).toHaveLength(1);
      expect(
        (await results().findOneByOrFail({ gameCommandId: command.id }))
          .outcome,
      ).toBe(expected);
    },
  );
  it('keeps disconnected transport PENDING and fails after bounded unavailable attempts', async () => {
    const disconnected = new DisconnectedGameGateway();
    gateway.responses = [
      await disconnected.send(),
      await disconnected.send(),
      await disconnected.send(),
    ];
    const command = await create();
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.PENDING);
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.FAILED);
    expect(
      await results().findOneByOrFail({ gameCommandId: command.id }),
    ).toMatchObject({ errorCode: 'GATEWAY_UNAVAILABLE' });
  });
  it('does not send when no healthy connection exists', async () => {
    await connections.disconnect(serverId, connection.id);
    const command = await create();
    await dispatcher.dispatch(command.id);
    expect(gateway.sends).toHaveLength(0);
    expect((await read(command.id)).status).toBe(S.PENDING);
    clock.advance(5000);
    await connections.connect({
      gameServerId: serverId,
      externalConnectionId: randomUUID(),
    });
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.DISPATCHED);
  });
  it('handles uncertain send failures without losing a valid early result', async () => {
    gateway.responses = [new Error('secret remote stack')];
    const command = await dispatched();
    expect(command.status).toBe(S.DISPATCHED);
    expect((await receiver.result(success(command))).status).toBe(S.SUCCEEDED);
  });
  it('ends permanent dispatch rejection as FAILED with one result', async () => {
    gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    const command = await dispatched();
    expect(command.status).toBe(S.FAILED);
    expect(
      await results().findOneByOrFail({ gameCommandId: command.id }),
    ).toMatchObject({ errorCode: 'DISPATCH_REJECTED' });
  });
  it('blocks disabled servers and fails queued work if the server is later disabled', async () => {
    const command = await create();
    await database.query(
      'UPDATE game_servers SET enabled = false WHERE id = $1',
      [serverId],
    );
    await expect(create()).rejects.toThrow('disabled');
    await expect(
      connections.connect({
        gameServerId: serverId,
        externalConnectionId: randomUUID(),
      }),
    ).rejects.toThrow('disabled');
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.FAILED);
    expect(gateway.sends).toHaveLength(0);
  });
  it('validates JSON size, attempts and foreign keys at the database boundary', async () => {
    const command = await create();
    await expect(
      database.query('UPDATE game_commands SET payload = $1 WHERE id = $2', [
        { nonce: 'x'.repeat(5000) },
        command.id,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      database.query(
        'UPDATE game_commands SET dispatch_attempts = -1 WHERE id = $1',
        [command.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await expect(
      database.query(
        'UPDATE game_commands SET requested_by_staff_id = $1 WHERE id = $2',
        [randomUUID(), command.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });
  it('rolls back terminal state when result persistence fails', async () => {
    const command = await dispatched();
    await database.query(
      `ALTER TABLE game_command_results ADD CONSTRAINT bridge_test_failure CHECK (game_command_id <> '${command.id}')`,
    );
    try {
      await expect(receiver.result(success(command))).rejects.toThrow();
    } finally {
      await database.query(
        'ALTER TABLE game_command_results DROP CONSTRAINT bridge_test_failure',
      );
    }
    expect((await read(command.id)).status).toBe(S.DISPATCHED);
    expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
  });
  it('serializes conflicting concurrent results with exactly one winner', async () => {
    const command = await dispatched();
    const outcomes = await Promise.allSettled([
      receiver.result(success(command)),
      receiver.result({
        ...ack(command),
        outcome: S.FAILED,
        errorCode: 'PING_REJECTED',
      }),
    ]);
    expect(
      outcomes.filter((value) => value.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((value) => value.status === 'rejected'),
    ).toHaveLength(1);
    const stored = await results().findOneByOrFail({
      gameCommandId: command.id,
    });
    expect((await read(command.id)).status).toBe(stored.outcome);
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
  });
  it('serializes ACK versus RESULT without losing completion', async () => {
    const command = await dispatched();
    await Promise.all([
      receiver.acknowledge(ack(command)),
      receiver.result(success(command)),
    ]);
    expect((await read(command.id)).status).toBe(S.SUCCEEDED);
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
  });
  it('deduplicates failure results without replacing terminal timestamps', async () => {
    const command = await dispatched();
    const message = {
      ...ack(command),
      outcome: S.FAILED as const,
      errorCode: 'BRIDGE_ERROR' as const,
    };
    const completed = await receiver.result(message);
    clock.advance(1000);
    expect((await receiver.result(message)).completedAt).toEqual(
      completed.completedAt,
    );
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
  });
  it('preserves staff attribution without requiring it for technical commands', async () => {
    const staffId = randomUUID();
    await database.query(
      "INSERT INTO staff_users(id, username, display_name, password_hash, role_name) VALUES ($1, $2, 'Technical Test', 'unused', 'COORDINATOR')",
      [staffId, `bridge-${staffId}`],
    );
    const command = await bus.submit({
      gameServerId: serverId,
      type: 'BRIDGE_PING',
      payload: { nonce: 'ping' },
      idempotencyKey: randomUUID(),
      requestedByStaffId: staffId,
    });
    expect(command.requestedByStaffId).toBe(staffId);
    expect((await create()).requestedByStaffId).toBeNull();
  });
  it('does not extend execution deadline when ACK arrives after retries', async () => {
    const command = await dispatched();
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    await receiver.acknowledge(ack(command));
    expect((await read(command.id)).executionDeadlineAt).toEqual(
      command.executionDeadlineAt,
    );
    clock.advance(25000);
    await receiver.expireCommands();
    expect((await read(command.id)).status).toBe(S.TIMEOUT);
  });
  it('counts unavailable retries without moving a DISPATCHED command backwards', async () => {
    const command = await dispatched();
    gateway.available = false;
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.DISPATCHED);
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.DISPATCHED);
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.TIMEOUT);
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
  });
  it('rechecks due commands inside locks when batch dispatchers compete', async () => {
    const command = await create();
    await Promise.all([
      dispatcher.dispatchPending(),
      dispatcher.dispatchPending(),
    ]);
    expect(
      gateway.sends.filter((value) => value.envelope.commandId === command.id),
    ).toHaveLength(1);
    expect((await read(command.id)).dispatchAttempts).toBe(1);
  });
  it('preserves uncertain delivery after a permanent retry refusal and eventually times out', async () => {
    gateway.responses = [
      new Error('delivery unknown'),
      { accepted: false, reason: 'PERMANENT' },
    ];
    const command = await dispatched();
    expect(command.status).toBe(S.DISPATCHED);
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.DISPATCHED);
    expect(await results().countBy({ gameCommandId: command.id })).toBe(0);
    clock.advance(25000);
    await receiver.expireCommands();
    expect((await read(command.id)).status).toBe(S.TIMEOUT);
  });
  it('accepts RESULT after retry rejection while the result is still timely', async () => {
    gateway.responses = [
      new Error('delivery unknown'),
      { accepted: false, reason: 'PERMANENT' },
    ];
    const command = await dispatched();
    clock.advance(5000);
    await dispatcher.dispatch(command.id);
    expect((await receiver.result(success(command))).status).toBe(S.SUCCEEDED);
  });
  it('does not infer failure when a server is disabled after dispatch', async () => {
    const command = await dispatched();
    await database.query(
      'UPDATE game_servers SET enabled = false WHERE id = $1',
      [serverId],
    );
    clock.advance(5000);
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.DISPATCHED);
    expect((await receiver.result(success(command))).status).toBe(S.SUCCEEDED);
  });
  it('holds no PostgreSQL row lock or transaction during gateway I/O and permits RESULT during send', async () => {
    const command = await create();
    gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    gateway.beforeSend = async () => {
      // Separate PostgreSQL connection must acquire both locks immediately.
      await database.transaction(async (manager) => {
        await manager.query(
          'SELECT id FROM game_servers WHERE id = $1 FOR UPDATE NOWAIT',
          [serverId],
        );
        await manager.query(
          'SELECT id FROM game_commands WHERE id = $1 FOR UPDATE NOWAIT',
          [command.id],
        );
      });
      expect(
        await database.query(
          "SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'idle in transaction' AND query LIKE '%game_commands%' AND query LIKE '%dispatch_lease%'",
        ),
      ).toEqual([]);
      const reserved = await read(command.id);
      expect(reserved.dispatchLeaseId).not.toBeNull();
      expect(reserved.dispatchAttempts).toBe(1);
      expect((await receiver.result(success(reserved))).status).toBe(
        S.SUCCEEDED,
      );
    };
    const completed = await dispatcher.dispatch(command.id);
    expect(completed.status).toBe(S.SUCCEEDED);
    expect(completed.dispatchLeaseId).toBeNull();
    expect(await results().countBy({ gameCommandId: command.id })).toBe(1);
  });
  it('allows ACK during send without transport reconciliation reverting it', async () => {
    const command = await create();
    gateway.beforeSend = async () => {
      await receiver.acknowledge(ack(await read(command.id)));
    };
    expect((await dispatcher.dispatch(command.id)).status).toBe(S.ACKNOWLEDGED);
    expect((await read(command.id)).dispatchLeaseId).toBeNull();
  });
  it('prevents a worker with an independent pool from sending a live claimed attempt', async () => {
    const command = await create();
    const otherDb = new DataSource(database.options);
    await otherDb.initialize();
    const otherGateway = new MockGameGateway();
    const otherServers = new GameServerService(otherDb);
    const config =
      module.get<ConfigService<{ application: ApplicationConfig }, true>>(
        ConfigService,
      );
    const other = new GameCommandDispatcher(
      otherDb,
      new GameCommandStore(otherDb, otherServers, clock),
      new GameConnectionService(otherDb, otherServers, clock, config),
      otherGateway,
      clock,
      config,
    );
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    gateway.beforeSend = async () => {
      started();
      await gate;
    };
    const first = dispatcher.dispatch(command.id);
    try {
      await sending;
      const reserved = await read(command.id);
      expect(reserved.dispatchLeaseId).not.toBeNull();
      await other.dispatch(command.id);
      expect(otherGateway.sends).toHaveLength(0);
      expect((await read(command.id)).dispatchAttempts).toBe(1);
    } finally {
      release();
      await first;
      await otherDb.destroy();
    }
    expect((await read(command.id)).status).toBe(S.DISPATCHED);
  });
  it('recovers a crash before send without claiming proven non-delivery', async () => {
    const command = await create();
    await commands().update(command.id, {
      dispatchLeaseId: randomUUID(),
      dispatchLeaseExpiresAt: new Date(clock.now().getTime() + 2000),
      dispatchedConnectionId: connection.id,
      dispatchAttempts: 1,
      lastDispatchAt: clock.now(),
      ackDeadlineAt: new Date(clock.now().getTime() + 5000),
      executionDeadlineAt: new Date(clock.now().getTime() + 30000),
    });
    await dispatcher.dispatch(command.id);
    expect(gateway.sends).toHaveLength(0);
    clock.advance(5000);
    gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    const recovered = await dispatcher.dispatch(command.id);
    expect(recovered.status).toBe(S.DISPATCHED);
    expect(recovered.dispatchAttempts).toBe(2);
    clock.advance(25000);
    await receiver.expireCommands();
    expect((await read(command.id)).status).toBe(S.TIMEOUT);
  });
  it('fences a stale transport response after lease expiry and another worker claim', async () => {
    const command = await create();
    const otherDb = new DataSource(database.options);
    await otherDb.initialize();
    const otherGateway = new MockGameGateway();
    const otherServers = new GameServerService(otherDb);
    const config =
      module.get<ConfigService<{ application: ApplicationConfig }, true>>(
        ConfigService,
      );
    const other = new GameCommandDispatcher(
      otherDb,
      new GameCommandStore(otherDb, otherServers, clock),
      new GameConnectionService(otherDb, otherServers, clock, config),
      otherGateway,
      clock,
      config,
    );
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    gateway.beforeSend = async () => {
      started();
      await gate;
    };
    gateway.responses = [{ accepted: false, reason: 'PERMANENT' }];
    const first = dispatcher.dispatch(command.id);
    try {
      await sending;
      const original = await read(command.id);
      clock.advance(5000);
      const retried = await other.dispatch(command.id);
      expect(retried.status).toBe(S.DISPATCHED);
      expect(retried.dispatchAttempts).toBe(2);
      expect(retried.executionDeadlineAt).toEqual(original.executionDeadlineAt);
      expect(otherGateway.sends[0].envelope.commandId).toBe(command.id);
      expect(otherGateway.sends[0].envelope.correlationId).toBe(
        command.correlationId,
      );
    } finally {
      release();
      await first;
      await otherDb.destroy();
    }
    expect((await read(command.id)).status).toBe(S.DISPATCHED);
    expect(
      (await receiver.result(success(await read(command.id)))).status,
    ).toBe(S.SUCCEEDED);
  });
  it('accepts a RESULT after send succeeded but its transport outcome was not reconciled', async () => {
    const command = await create();
    // Persisted claim left by a crashed sender; Agent can still reply by stable IDs.
    await commands().update(command.id, {
      dispatchLeaseId: randomUUID(),
      dispatchLeaseExpiresAt: new Date(clock.now().getTime() + 2000),
      dispatchedConnectionId: connection.id,
      dispatchAttempts: 1,
      ackDeadlineAt: new Date(clock.now().getTime() + 5000),
      executionDeadlineAt: new Date(clock.now().getTime() + 30000),
    });
    clock.advance(2100);
    expect(
      (await receiver.result(success(await read(command.id)))).status,
    ).toBe(S.SUCCEEDED);
    expect(gateway.sends).toHaveLength(0);
    expect((await read(command.id)).dispatchLeaseId).toBeNull();
  });
  it('expires an abandoned first claim even if no dispatch worker returns', async () => {
    const command = await create();
    await commands().update(command.id, {
      dispatchLeaseId: randomUUID(),
      dispatchLeaseExpiresAt: new Date(clock.now().getTime() + 2000),
      dispatchedConnectionId: connection.id,
      dispatchAttempts: 1,
      ackDeadlineAt: new Date(clock.now().getTime() + 5000),
      executionDeadlineAt: new Date(clock.now().getTime() + 30000),
    });
    clock.advance(30000);
    await receiver.expireCommands();
    expect((await read(command.id)).status).toBe(S.TIMEOUT);
    expect(
      (await results().findOneByOrFail({ gameCommandId: command.id })).outcome,
    ).toBe(S.TIMEOUT);
  });
});
