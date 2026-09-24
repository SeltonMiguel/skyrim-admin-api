import { ConflictException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import { RoleName as R } from '../src/rbac/roles.js';
import {
  AuditAction as A,
  AuditOutcome,
  AuditResource,
} from '../src/audit/audit.types.js';
import { AuditService } from '../src/audit/audit.service.js';
import { GameCommandBus } from '../src/game-bridge/game-command-bus.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameCommand } from '../src/game-bridge/entities/game-command.entity.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { ActorCommandService } from '../src/actor-operations/actor-command.service.js';
import {
  ActorType,
  playerActor,
  staffActor,
  systemActor,
  SystemSource,
} from '../src/actors/actor.contracts.js';
import type { StaffActor } from '../src/actors/actor.contracts.js';
import { PlayerAccountService } from '../src/player-accounts/player-account.service.js';
import { IdentityProvider } from '../src/player-accounts/player-account.contracts.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
describeDatabase(
  'Generic actor and scoped idempotency with real PostgreSQL',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let bus: GameCommandBus, core: ActorCommandService, audit: AuditService;
    let servers: GameServerService, players: PlayerAccountService;
    let server: GameServer, coordinator: StaffActor, other: StaffActor;
    let playerA: string, playerB: string;
    const subject = `subject-${randomUUID()}`;
    const legacy = {
      staffId: randomUUID(),
      serverId: randomUUID(),
      auditId: randomUUID(),
      commandId: randomUUID(),
      unattributedId: randomUUID(),
      key: `legacy-${randomUUID()}`,
    };
    const tokens = new Map<R, string>();
    const schema = `generic_actor_test_${randomUUID().replaceAll('-', '')}`;
    const http = () => request(app.getHttpServer());
    const ping = (nonce = 'ping') => ({
      gameServerId: server.id,
      type: 'BRIDGE_PING' as const,
      payload: { nonce },
    });
    const commands = () => database.getRepository<GameCommand>('GameCommand');
    const rawCommand = (values: Record<string, unknown>) =>
      database.query(
        `INSERT INTO game_commands(game_server_id, type, payload, idempotency_key, correlation_id, ${Object.keys(values).join(', ')})
       VALUES ($1, 'BRIDGE_PING', '{"nonce":"n"}', $2, $3, ${Object.keys(values)
         .map((_, i) => `$${i + 4}`)
         .join(', ')})`,
        [server.id, randomUUID(), randomUUID(), ...Object.values(values)],
      );
    const rawAudit = (values: Record<string, unknown>) =>
      database.query(
        `INSERT INTO audit_logs(action, outcome, ${Object.keys(values).join(', ')})
       VALUES ('AUTH_LOGIN', 'SUCCESS', ${Object.keys(values)
         .map((_, i) => `$${i + 1}`)
         .join(', ')})`,
        Object.values(values),
      );
    const violation = (code: string) =>
      expect.objectContaining({
        driverError: expect.objectContaining({ code }),
      });
    beforeAll(async () => {
      const options = createDatabaseOptions(loadEnvironment());
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
      expect(await database.runMigrations()).toHaveLength(12);
      // Write pre-10.2 history, then re-apply the migrations over it.
      await database.undoLastMigration(); // Etapa 10.3 Player Sessions
      await database.undoLastMigration();
      await database.query(
        "INSERT INTO staff_users(id, username, display_name, password_hash, role_name) VALUES ($1, 'legacy', 'Legacy', 'x', 'COORDINATOR')",
        [legacy.staffId],
      );
      await database.query(
        "INSERT INTO game_servers(id, code, name) VALUES ($1, $2, 'Legacy')",
        [legacy.serverId, randomUUID()],
      );
      await database.query(
        "INSERT INTO audit_logs(id, actor_staff_id, actor_username, actor_display_name, actor_role, action, outcome) VALUES ($1, $2, 'legacy', 'Legacy', 'COORDINATOR', 'STAFF_CREATE', 'SUCCESS')",
        [legacy.auditId, legacy.staffId],
      );
      await database.query(
        `INSERT INTO game_commands(id, game_server_id, type, payload, idempotency_key, correlation_id, requested_by_staff_id)
       VALUES ($1, $2, 'BRIDGE_PING', '{"nonce":"legacy"}', $3, $4, $5),
              ($6, $2, 'BRIDGE_PING', '{"nonce":"internal"}', $7, $8, NULL)`,
        [
          legacy.commandId,
          legacy.serverId,
          legacy.key,
          randomUUID(),
          legacy.staffId,
          legacy.unattributedId,
          `${legacy.key}-internal`,
          randomUUID(),
        ],
      );
      expect(await database.runMigrations()).toHaveLength(2);
      expect(await database.runMigrations()).toHaveLength(0);
      const { AppModule } = await import('../src/app.module.js');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DataSource)
        .useValue(database)
        .compile();
      app = module.createNestApplication(new AppExpressAdapter());
      app.useLogger(false);
      setupApp(app);
      await app.listen(0, '127.0.0.1');
      bus = app.get(GameCommandBus);
      core = app.get(ActorCommandService);
      audit = app.get(AuditService);
      servers = app.get(GameServerService);
      players = app.get(PlayerAccountService);
      const password = 'Generic-Actor-Password-42';
      const hash = await new PasswordService().hash(password);
      for (const role of [R.COORDINATOR, R.SUPPORT, R.GENERAL_CHIEF]) {
        const id = randomUUID();
        await database.query(
          'INSERT INTO staff_users(id, username, display_name, password_hash, role_name) VALUES ($1,$2,$3,$4,$5)',
          [id, role.toLowerCase(), role, hash, role],
        );
        const { body } = await http()
          .post('/api/v1/auth/login')
          .send({ username: role.toLowerCase(), password })
          .expect(200);
        tokens.set(role, body.accessToken);
        const actor = staffActor({
          id,
          username: role.toLowerCase(),
          displayName: role,
          roleName: role,
        });
        if (role === R.COORDINATOR) coordinator = actor;
        if (role === R.GENERAL_CHIEF) other = actor;
      }
      playerA = (
        await players.createPlayer({
          displayName: 'Player A',
          identity: {
            provider: IdentityProvider.DISCORD,
            providerSubject: subject,
          },
        })
      ).id;
      playerB = (await players.createPlayer({ displayName: 'Player B' })).id;
    }, 30000);
    beforeEach(async () => {
      server = await servers.register({
        code: randomUUID(),
        name: 'Actor test',
      });
    });
    afterAll(async () => {
      await app?.close();
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    it('applies over history without rewriting Audit, keeps the trigger and has no schema diff', async () => {
      expect(database.options.synchronize).toBe(false);
      expect(await database.showMigrations()).toBe(false);
      const diff = await database.driver.createSchemaBuilder().log();
      expect(diff.upQueries).toEqual([]);
      expect(diff.downQueries).toEqual([]);
      const [row] = await database.query(
        'SELECT actor_type, actor_player_id, actor_system_source, actor_staff_id, actor_role FROM audit_logs WHERE id = $1',
        [legacy.auditId],
      );
      expect(row).toEqual({
        actor_type: null,
        actor_player_id: null,
        actor_system_source: null,
        actor_staff_id: legacy.staffId,
        actor_role: 'COORDINATOR',
      });
      const [trigger] = await database.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_logs_immutable'",
      );
      expect(trigger.tgenabled).toBe('A');
      await expect(
        database.query(
          "UPDATE audit_logs SET actor_type = 'STAFF' WHERE id = $1",
          [legacy.auditId],
        ),
      ).rejects.toEqual(violation('55000'));
      const [constraint] = await database.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'game_commands_idempotency_key' AND connamespace = $1::regnamespace",
        [schema],
      );
      expect(constraint.definition).toBe(
        'UNIQUE (game_server_id, idempotency_scope, idempotency_key)',
      );
    });
    it('reads historical Audit as STAFF and historical commands in the shared STAFF scope', async () => {
      const entry = await http()
        .get(`/api/v1/audit/${legacy.auditId}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(200);
      expect(entry.body).toMatchObject({
        actorType: ActorType.STAFF,
        actorStaffId: legacy.staffId,
        actorRole: 'COORDINATOR',
        actorPlayerId: null,
        actorSystemSource: null,
      });
      const rows = await commands().findBy({ gameServerId: legacy.serverId });
      expect(
        rows.map((c) => [c.id, c.actorType, c.idempotencyScope]).sort(),
      ).toEqual(
        [
          [legacy.commandId, 'STAFF', 'STAFF'],
          [legacy.unattributedId, 'STAFF', 'STAFF'],
        ].sort(),
      );
      // A current staff replay of a historical key returns the historical command.
      const replay = await core.create(
        {
          gameServerId: legacy.serverId,
          type: 'BRIDGE_PING',
          payload: { nonce: 'legacy' },
          idempotencyKey: legacy.key,
        },
        coordinator,
      );
      expect(replay).toMatchObject({
        created: false,
        command: { id: legacy.commandId },
      });
      await http()
        .get(`/api/v1/game-commands/${legacy.commandId}`)
        .auth(tokens.get(R.SUPPORT)!, { type: 'bearer' })
        .expect(200);
    });
    it('enforces exactly one actor shape per command in PostgreSQL, with FKs for staff and player', async () => {
      for (const values of [
        { actor_type: 'PLAYER', requested_by_player_id: playerA },
        {
          actor_type: 'PLAYER',
          requested_by_player_id: playerA,
          requested_by_staff_id: coordinator.id,
          idempotency_scope: `PLAYER:${playerA}`,
        },
        {
          actor_type: 'PLAYER',
          requested_by_player_id: playerA,
          idempotency_scope: `PLAYER:${playerB}`,
        },
        { actor_type: 'STAFF', requested_by_player_id: playerA },
        { actor_type: 'STAFF', idempotency_scope: 'SYSTEM:AGENT' },
        {
          actor_type: 'SYSTEM',
          requested_by_system_source: 'SHELL',
          idempotency_scope: 'SYSTEM:SHELL',
        },
        {
          actor_type: 'SYSTEM',
          requested_by_system_source: 'AGENT',
          idempotency_scope: 'SYSTEM:PROFESSION',
        },
        { actor_type: 'SYSTEM', idempotency_scope: 'SYSTEM:' },
        { actor_type: 'ADMIN' },
      ])
        await expect(rawCommand(values)).rejects.toEqual(violation('23514'));
      const orphan = randomUUID();
      await expect(
        rawCommand({
          actor_type: 'PLAYER',
          requested_by_player_id: orphan,
          idempotency_scope: `PLAYER:${orphan}`,
        }),
      ).rejects.toEqual(violation('23503'));
      await expect(
        rawCommand({ requested_by_staff_id: randomUUID() }),
      ).rejects.toEqual(violation('23503'));
      await expect(
        bus.submit({
          ...ping(),
          idempotencyKey: randomUUID(),
          actor: playerActor(randomUUID()),
        }),
      ).rejects.toEqual(violation('23503'));
      expect(await commands().countBy({ gameServerId: server.id })).toBe(0);
    });
    it('enforces exactly one actor shape per Audit row and keeps actor_role staff-only', async () => {
      for (const values of [
        { actor_type: 'PLAYER', actor_player_id: playerA, actor_role: 'ADMIN' },
        { actor_type: 'PLAYER', actor_player_id: playerA, actor_username: 'x' },
        {
          actor_type: 'PLAYER',
          actor_player_id: playerA,
          actor_staff_id: coordinator.id,
        },
        { actor_type: 'PLAYER' },
        {
          actor_type: 'SYSTEM',
          actor_system_source: 'AGENT',
          actor_role: 'DEV',
        },
        { actor_type: 'SYSTEM', actor_system_source: 'SHELL' },
        { actor_type: 'SYSTEM' },
        { actor_type: 'STAFF' },
        {
          actor_type: 'STAFF',
          actor_staff_id: coordinator.id,
          actor_player_id: playerA,
        },
        { actor_player_id: playerA },
        { actor_system_source: 'AGENT' },
        { actor_type: 'ROBOT', actor_staff_id: coordinator.id },
      ])
        await expect(rawAudit(values)).rejects.toEqual(violation('23514'));
    });
    it('persists PLAYER and SYSTEM commands internally with their own attribution', async () => {
      const player = await bus.submit({
        ...ping(),
        idempotencyKey: 'k',
        actor: playerActor(playerA.toUpperCase()),
      });
      expect(player).toMatchObject({
        actorType: ActorType.PLAYER,
        requestedByPlayerId: playerA,
        requestedByStaffId: null,
        requestedBySystemSource: null,
        idempotencyScope: `PLAYER:${playerA}`,
      });
      const system = await bus.submit({
        ...ping(),
        idempotencyKey: 'k',
        actor: systemActor(SystemSource.AGENT),
      });
      expect(system).toMatchObject({
        actorType: ActorType.SYSTEM,
        requestedBySystemSource: SystemSource.AGENT,
        requestedByStaffId: null,
        requestedByPlayerId: null,
        idempotencyScope: 'SYSTEM:AGENT',
      });
      const staff = await bus.submit({
        ...ping(),
        idempotencyKey: 'k',
        requestedByStaffId: coordinator.id,
      });
      expect(staff).toMatchObject({
        actorType: ActorType.STAFF,
        requestedByStaffId: coordinator.id,
        idempotencyScope: 'STAFF',
      });
      expect(new Set([player.id, system.id, staff.id]).size).toBe(3);
      await expect(
        bus.submit({
          ...ping(),
          idempotencyKey: 'x',
          actor: playerActor(playerA),
          requestedByStaffId: coordinator.id,
        }),
      ).rejects.toThrow('exclusive');
      for (const actor of [
        { type: 'PLAYER', playerId: 'not-a-uuid' },
        { type: 'PLAYER', playerId: playerA, roleName: R.COORDINATOR },
        { type: 'SYSTEM', source: 'SHELL' },
        {
          type: 'STAFF',
          id: coordinator.id,
          username: 'x',
          displayName: 'x',
          roleName: R.COORDINATOR,
          permissions: [],
        },
        { type: 'ADMIN', id: coordinator.id },
      ])
        await expect(
          bus.submit({
            ...ping(),
            idempotencyKey: randomUUID(),
            actor: actor as never,
          }),
        ).rejects.toThrow('Invalid actor');
    });
    it('preserves the shared STAFF scope across staff users and unattributed internal submits', async () => {
      const key = randomUUID();
      const first = await core.create(
        { ...ping(), idempotencyKey: key },
        coordinator,
      );
      const second = await core.create(
        { ...ping(), idempotencyKey: key },
        other,
      );
      const internal = await bus.submit({ ...ping(), idempotencyKey: key });
      expect(first.created).toBe(true);
      expect(second).toMatchObject({
        created: false,
        command: { id: first.command.id },
      });
      expect(internal.id).toBe(first.command.id);
      expect(internal.requestedByStaffId).toBe(coordinator.id);
      await expect(
        core.create({ ...ping('other'), idempotencyKey: key }, other),
      ).rejects.toBeInstanceOf(ConflictException);
    });
    it('isolates player keys: retries converge, conflicts are 409, other actors are independent', async () => {
      const key = 'shared-key';
      const staff = await core.create(
        { ...ping(), idempotencyKey: key },
        coordinator,
      );
      const a = await core.create(
        { ...ping(), idempotencyKey: key },
        playerActor(playerA),
      );
      const retry = await core.create(
        { ...ping(), idempotencyKey: key },
        playerActor(playerA),
      );
      expect(a.created).toBe(true);
      expect(retry).toMatchObject({
        created: false,
        command: { id: a.command.id },
      });
      await expect(
        core.create(
          { ...ping('different'), idempotencyKey: key },
          playerActor(playerA),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      // Player B reusing the key with another payload neither sees nor conflicts with A.
      const b = await core.create(
        { ...ping('different'), idempotencyKey: key },
        playerActor(playerB),
      );
      expect(b.created).toBe(true);
      expect(b.command.id).not.toBe(a.command.id);
      expect(b.command.correlationId).not.toBe(a.command.correlationId);
      expect(b.command.requestedByPlayerId).toBe(playerB);
      const profession = await core.create(
        { ...ping(), idempotencyKey: key },
        systemActor(SystemSource.PROFESSION),
      );
      const delivery = await core.create(
        { ...ping('other'), idempotencyKey: key },
        systemActor(SystemSource.VIP_DELIVERY),
      );
      const again = await core.create(
        { ...ping(), idempotencyKey: key },
        systemActor(SystemSource.PROFESSION),
      );
      expect(again).toMatchObject({
        created: false,
        command: { id: profession.command.id },
      });
      expect(
        new Set([staff, a, b, profession, delivery].map((r) => r.command.id))
          .size,
      ).toBe(5);
      expect(await commands().countBy({ gameServerId: server.id })).toBe(5);
    });
    it('lets PostgreSQL resolve concurrent same-scope retries and cross-scope reuse', async () => {
      const key = randomUUID();
      const racing = await Promise.all(
        Array.from({ length: 8 }, () =>
          core.create({ ...ping(), idempotencyKey: key }, playerActor(playerA)),
        ),
      );
      expect(new Set(racing.map((r) => r.command.id)).size).toBe(1);
      expect(racing.filter((r) => r.created)).toHaveLength(1);
      const crossKey = randomUUID();
      const crossed = await Promise.all(
        [playerA, playerB, playerA, playerB].map((id) =>
          core.create({ ...ping(), idempotencyKey: crossKey }, playerActor(id)),
        ),
      );
      expect(new Set(crossed.map((r) => r.command.id)).size).toBe(2);
      const conflicting = await Promise.allSettled([
        core.create(
          { ...ping('one'), idempotencyKey: 'race' },
          playerActor(playerB),
        ),
        core.create(
          { ...ping('two'), idempotencyKey: 'race' },
          playerActor(playerB),
        ),
      ]);
      expect(conflicting.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      // One racing command, two cross-scope commands, one conflict winner.
      expect(await commands().countBy({ gameServerId: server.id })).toBe(4);
    });
    it('audits PLAYER and SYSTEM atomically with safe identity only', async () => {
      const event = (command: GameCommand) => ({
        action: A.WORLD_TIME_SET_REQUESTED,
        resourceType: AuditResource.WORLD,
        resourceId: command.id,
        metadata: { commandId: command.id },
      });
      const byPlayer = await core.create(
        { ...ping(), idempotencyKey: randomUUID() },
        playerActor(playerA),
        event,
      );
      const bySystem = await core.create(
        { ...ping(), idempotencyKey: randomUUID() },
        systemActor(SystemSource.VIP_DELIVERY),
        event,
      );
      const rows = async (id: string) =>
        database.query('SELECT * FROM audit_logs WHERE resource_id = $1', [id]);
      const [playerRow] = await rows(byPlayer.command.id);
      expect(playerRow).toMatchObject({
        actor_type: 'PLAYER',
        actor_player_id: playerA,
        actor_staff_id: null,
        actor_username: null,
        actor_display_name: null,
        actor_role: null,
        actor_system_source: null,
        status_code: 202,
      });
      const [systemRow] = await rows(bySystem.command.id);
      expect(systemRow).toMatchObject({
        actor_type: 'SYSTEM',
        actor_system_source: 'VIP_DELIVERY',
        actor_staff_id: null,
        actor_player_id: null,
        actor_role: null,
      });
      const view = await http()
        .get(`/api/v1/audit/${playerRow.id}`)
        .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
        .expect(200);
      expect(view.body).toMatchObject({
        actorType: 'PLAYER',
        actorPlayerId: playerA,
        actorRole: null,
        actorStaffId: null,
      });
      expect(view.text).not.toContain(subject);
      expect(view.text).not.toMatch(/idempotency|scope|PLAYER:/i);
      // Retry audits nothing new.
      await core.create(
        { ...ping(), idempotencyKey: byPlayer.command.idempotencyKey },
        playerActor(playerA),
        event,
      );
      expect(await rows(byPlayer.command.id)).toHaveLength(1);
      // Staff audit rows now carry an explicit STAFF type.
      await audit.record({
        actor: {
          id: coordinator.id,
          username: 'c',
          displayName: 'C',
          roleName: R.COORDINATOR,
        },
        action: A.STAFF_UPDATE,
        outcome: AuditOutcome.SUCCESS,
        resourceId: 'staff-marker',
      });
      const [staffRow] = await database.query(
        "SELECT actor_type, actor_role FROM audit_logs WHERE resource_id = 'staff-marker'",
      );
      expect(staffRow).toEqual({
        actor_type: 'STAFF',
        actor_role: 'COORDINATOR',
      });
    });
    it('rolls back a PLAYER command when its Audit fails', async () => {
      const marker = randomUUID();
      const key = randomUUID();
      await database.query(
        `ALTER TABLE audit_logs ADD CONSTRAINT generic_actor_audit_failure CHECK (metadata->>'marker' IS DISTINCT FROM '${marker}')`,
      );
      try {
        await expect(
          core.create(
            { ...ping(), idempotencyKey: key },
            playerActor(playerA),
            () => ({
              action: A.WORLD_TIME_SET_REQUESTED,
              metadata: { marker },
            }),
          ),
        ).rejects.toThrow('Audit persistence unavailable');
        expect(await commands().countBy({ idempotencyKey: key })).toBe(0);
      } finally {
        await database.query(
          'ALTER TABLE audit_logs DROP CONSTRAINT generic_actor_audit_failure',
        );
      }
    });
    it('keeps the scope and player attribution out of every HTTP response and accepts no actor input', async () => {
      const command = (
        await core.create(
          { ...ping(), idempotencyKey: randomUUID() },
          playerActor(playerA),
        )
      ).command;
      const detail = await http()
        .get(`/api/v1/game-commands/${command.id}`)
        .auth(tokens.get(R.SUPPORT)!, { type: 'bearer' })
        .expect(200);
      expect(detail.text).not.toMatch(/idempotency|scope|PLAYER:|actorType/i);
      expect(detail.text).not.toContain(playerA);
      const list = await http()
        .get(`/api/v1/game-servers/${server.id}/commands`)
        .auth(tokens.get(R.SUPPORT)!, { type: 'bearer' })
        .expect(200);
      expect(list.text).not.toMatch(/idempotency|scope|PLAYER:/i);
      expect(list.text).not.toContain(playerA);
      for (const extra of [
        { actorType: 'PLAYER' },
        { actor: { type: 'SYSTEM', source: 'AGENT' } },
        { requestedByPlayerId: playerA },
        { idempotencyScope: 'SYSTEM:AGENT' },
        { systemSource: 'AGENT' },
      ])
        await http()
          .post(`/api/v1/game-servers/${server.id}/world/time`)
          .auth(tokens.get(R.COORDINATOR)!, { type: 'bearer' })
          .set('Idempotency-Key', randomUUID())
          .send({ gameHour: 1, ...extra })
          .expect(400);
      for (const path of [
        '/api/v1/player/commands',
        '/api/v1/player/characters',
      ])
        await http().get(path).expect(404);
    });
    it('refuses to revert while PLAYER or SYSTEM data exists, without losing it', async () => {
      await core.create(
        { ...ping(), idempotencyKey: randomUUID() },
        systemActor(SystemSource.AGENT),
      );
      // 10.3 reverts cleanly; 10.2 then refuses to drop PLAYER/SYSTEM data.
      await database.undoLastMigration();
      await expect(database.undoLastMigration()).rejects.toThrow();
      expect(await database.runMigrations()).toHaveLength(1);
      expect(await database.showMigrations()).toBe(false);
      expect(
        await commands().countBy({ actorType: ActorType.SYSTEM }),
      ).toBeGreaterThan(0);
    });
  },
);
