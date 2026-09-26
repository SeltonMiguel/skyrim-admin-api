import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { compiledDatabaseArtifacts } from './compiled-database.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createDatabaseOptions } from '../src/database/database.options.js';
import { setupApp } from '../src/setup-app.js';
import { AppExpressAdapter } from '../src/common/http/app-express.adapter.js';
import { PasswordService } from '../src/auth/password.service.js';
import {
  playerActor,
  systemActor,
  SystemSource,
} from '../src/actors/actor.contracts.js';
import { EconomyService } from '../src/economy/economy.service.js';
import { GameServerService } from '../src/game-bridge/game-server.service.js';
import type { GameServer } from '../src/game-bridge/entities/game-server.entity.js';
import { DiscordIdentityProvider } from '../src/player-auth/discord-identity.provider.js';
import { PlayerAuthRateLimiter } from '../src/player-auth/player-auth-rate-limit.js';
import { CharacterLinkService } from '../src/player-characters/character-link.service.js';
import { AgentSessionRegistry } from '../src/game-agent/agent-session.registry.js';
import { AgentDomainEventService } from '../src/game-agent/agent-domain-events.service.js';
import { VipEntitlementService } from '../src/vip-entitlements/vip-entitlement.service.js';
import { VipDeliveryService } from '../src/vip-entitlements/vip-delivery.service.js';
import { VipEntitlementScope } from '../src/vip-store/vip-offer.contracts.js';
import { FakeDiscordProvider } from './support/fake-discord-provider.js';
import { FakeAgent, FakeTradeJournal } from './support/fake-agent.js';
import type { Frame } from './support/fake-agent.js';

const describeDatabase =
  process.env.TEST_DATABASE_INTEGRATION === 'true' ? describe : describe.skip;
const ENV = {
  AGENT_WORK_PUSH_INTERVAL_MS: '150',
  VIP_DELIVERY_WORKER_INTERVAL_MS: '100',
  GAME_COMMAND_WORKER_INTERVAL_MS: '100',
};
const GIVE_CAPS = [
  'GAME_COMMAND_V1',
  'COMMAND_DEDUP_V1',
  'CHARACTER_ITEM_GIVE',
  'CHARACTER_TITLE_GIVE',
];
type Session = { accessToken: string; player: { id: string } };
type Party = { session: Session; link: string; char: string };
async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 6000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDatabase(
  'Host Agent domain events and gameplay work with real PostgreSQL',
  () => {
    let admin: DataSource, database: DataSource, app: INestApplication<App>;
    let servers: GameServerService, registry: AgentSessionRegistry;
    let links: CharacterLinkService, economy: EconomyService;
    let server: GameServer, other: GameServer, url: string;
    let staffToken: string;
    const agents: FakeAgent[] = [];
    const discord = new FakeDiscordProvider();
    const schema = `agent_events_test_${randomUUID().replaceAll('-', '')}`;
    const http = () => request(app.getHttpServer());
    const credential = async (serverId: string) =>
      (
        await http()
          .post(`/api/v1/admin/game-servers/${serverId}/agent-credentials`)
          .auth(staffToken, { type: 'bearer' })
          .expect(201)
      ).body as { credentialId: string; credentialSecret: string };
    const agent = async (
      on: GameServer = server,
      capabilities: string[] = [],
      options: {
        key?: Awaited<ReturnType<typeof credential>>;
        journal?: FakeAgent;
      } = {},
    ) => {
      const created = new FakeAgent(
        url,
        on.id,
        options.journal?.journal,
        options.journal?.executions,
      );
      agents.push(created);
      await created.hello(
        options.key ?? (await credential(on.id)),
        capabilities,
        { gameProcessState: 'RUNNING', skseReady: true },
      );
      return created;
    };
    const login = async (): Promise<Session> => {
      const code = `code-${randomUUID()}`;
      discord.codes.set(code, {
        subject: `${Date.now()}${Math.floor(Math.random() * 1e9)}`,
        displayName: 'Player',
      });
      return (
        await http()
          .post('/api/v1/player/auth/discord/exchange')
          .send({ authorizationCode: code, redirectUri: 'http://127.0.0.1/cb' })
          .expect(200)
      ).body;
    };
    // A verified party of `server` (the domain service, as the Agent would).
    const party = async (gold = 0, on: GameServer = server): Promise<Party> => {
      const session = await login();
      const char = `char:${randomUUID()}`;
      const requested = await links.request(playerActor(session.player.id), {
        gameServerId: on.id,
        characterExternalId: char,
      });
      await links.confirmFromAgent({
        challenge: requested.challenge,
        gameServerId: on.id,
        characterExternalId: char,
      });
      if (gold)
        expect(
          await economy.creditFromSystem({
            gameServerId: on.id,
            characterExternalId: char,
            amount: gold,
            idempotencyKey: randomUUID(),
            source: SystemSource.AGENT,
          }),
        ).toMatchObject({ outcome: 'POSTED' });
      return { session, link: requested.link.id, char };
    };
    const balance = async (char: string, on: GameServer = server) => {
      const [row] = await database.query(
        "SELECT balance FROM economy_accounts WHERE game_server_id = $1 AND owner_type = 'CHARACTER' AND character_external_id = $2",
        [on.id, char],
      );
      return row ? Number(row.balance) : 0;
    };
    const player = (
      method: 'post' | 'put' | 'get',
      session: Session,
      path: string,
      body?: object,
    ) => {
      const call = http()
        [method](`/api/v1/player/${path}`)
        .auth(session.accessToken, { type: 'bearer' });
      return method === 'get'
        ? call
        : call.set('Idempotency-Key', randomUUID()).send(body ?? {});
    };
    const one = async (sql: string, params: unknown[]) =>
      (await database.query(sql, params))[0];
    const receipts = (eventId: string) =>
      database.query(
        'SELECT * FROM agent_domain_event_receipts WHERE event_id = $1',
        [eventId],
      );
    const ack = (frame: Frame) => ({
      type: 'DOMAIN_EVENT_ACK',
      payload: expect.objectContaining({
        inReplyTo: frame.messageId,
        eventId: frame.payload!.eventId,
        kind: frame.payload!.kind,
      }),
    });
    const work = (pages: Frame[], kind?: string) =>
      pages
        .flatMap(
          (p) =>
            p.payload!.items as {
              workId: string;
              kind: string;
              data: unknown;
            }[],
        )
        .filter((i) => !kind || i.kind === kind);

    beforeAll(async () => {
      Object.assign(process.env, ENV);
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
      expect(await database.runMigrations()).toHaveLength(26);
      const { AppModule } = await import('../src/app.module.js');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DataSource)
        .useValue(database)
        .overrideProvider(DiscordIdentityProvider)
        .useValue(discord)
        .compile();
      app = module.createNestApplication(new AppExpressAdapter());
      app.useLogger(false);
      setupApp(app);
      await app.listen(0, '127.0.0.1');
      const address = (
        app.getHttpServer() as unknown as Server
      ).address() as AddressInfo;
      url = `ws://127.0.0.1:${address.port}`;
      servers = app.get(GameServerService);
      registry = app.get(AgentSessionRegistry);
      links = app.get(CharacterLinkService);
      economy = app.get(EconomyService);
      const password = 'Agent-Events-Password-42';
      await database.query(
        "INSERT INTO staff_users(username, display_name, password_hash, role_name) VALUES ('coordinator', 'C', $1, 'COORDINATOR')",
        [await new PasswordService().hash(password)],
      );
      staffToken = (
        await http()
          .post('/api/v1/auth/login')
          .send({ username: 'coordinator', password })
          .expect(200)
      ).body.accessToken;
    }, 60000);
    beforeEach(async () => {
      app.get(PlayerAuthRateLimiter).reset();
      server = await servers.register({ code: randomUUID(), name: 'Home' });
      other = await servers.register({ code: randomUUID(), name: 'Other' });
    });
    afterEach(async () => {
      for (const created of agents.splice(0)) await created.close();
      await eventually(async () => registry.count() === 0);
    });
    afterAll(async () => {
      for (const name of Object.keys(ENV)) delete process.env[name];
      await app?.close();
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    it('verifies character ownership from the in-game proof, once, only on its own server', async () => {
      const session = await login();
      const char = `char:${randomUUID()}`;
      const requested = await links.request(playerActor(session.player.id), {
        gameServerId: server.id,
        characterExternalId: char,
      });
      const home = await agent(server);
      const foreign = await agent(other);
      const proof = {
        challenge: requested.challenge,
        characterExternalId: char,
      };
      const status = async () =>
        (
          await one('SELECT status FROM player_characters WHERE id = $1', [
            requested.link.id,
          ])
        ).status;
      // Another server's Agent cannot confirm this server's challenge. The
      // player typed a code of another server: refused, session kept.
      const cross = await foreign.reply(
        foreign.event('CHARACTER_OWNERSHIP_PROOF', proof),
      );
      expect(cross.payload).toMatchObject({
        code: 'DOMAIN_REJECTED',
        reason: 'CHALLENGE_MISMATCH',
        retryable: false,
      });
      expect(foreign.client.closed).toBeNull();
      expect(await status()).toBe('PENDING');
      // The Agent never names the player, the link or a status.
      for (const extra of [
        { playerId: session.player.id },
        { linkId: requested.link.id },
        { status: 'VERIFIED' },
        { gameServerId: server.id },
      ])
        expect(
          (
            await home.reply(
              home.event('CHARACTER_OWNERSHIP_PROOF', { ...proof, ...extra }),
            )
          ).payload,
        ).toMatchObject({ code: 'INVALID_MESSAGE' });
      const wrong = await home.reply(
        home.event('CHARACTER_OWNERSHIP_PROOF', {
          ...proof,
          challenge: 'AAAA-BBBB-CCCCC',
        }),
      );
      expect(wrong.payload).toMatchObject({ reason: 'INVALID_CHALLENGE' });
      expect(await status()).toBe('PENDING');
      const eventId = randomUUID();
      const first = home.event('CHARACTER_OWNERSHIP_PROOF', proof, eventId);
      expect(await home.reply(first)).toMatchObject({
        ...ack(first),
        payload: expect.objectContaining({ duplicate: false }),
      });
      expect(await status()).toBe('VERIFIED');
      // Retry (e.g. after a reconnect): duplicate, nothing new.
      const again = home.event('CHARACTER_OWNERSHIP_PROOF', proof, eventId);
      expect((await home.reply(again)).payload).toMatchObject({
        duplicate: true,
      });
      // Same eventId, other content or kind: conflict.
      for (const [kind, data] of [
        ['CHARACTER_OWNERSHIP_PROOF', { ...proof, characterExternalId: 'x' }],
        ['PROFESSION_EXPERIENCE', { characterExternalId: char, amount: 1 }],
      ] as const)
        expect(
          (await home.reply(home.event(kind, data, eventId))).payload,
        ).toMatchObject({ code: 'EVENT_CONFLICT' });
      // The challenge is single use: another event id re-proves the same link.
      expect(
        (await home.reply(home.event('CHARACTER_OWNERSHIP_PROOF', proof)))
          .payload,
      ).toMatchObject({ duplicate: true });
      // The receipt never stores the proof.
      const [receipt] = await receipts(eventId);
      expect(receipt).toMatchObject({
        game_server_id: server.id,
        kind: 'CHARACTER_OWNERSHIP_PROOF',
        status: 'APPLIED',
      });
      expect(JSON.stringify(receipt)).not.toContain(requested.challenge);
      // Expired challenge.
      const late = await links.request(playerActor(session.player.id), {
        gameServerId: server.id,
        characterExternalId: `char:${randomUUID()}`,
      });
      await database.query(
        "UPDATE player_character_link_challenges SET created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' WHERE player_character_id = $1",
        [late.link.id],
      );
      expect(
        (
          await home.reply(
            home.event('CHARACTER_OWNERSHIP_PROOF', {
              challenge: late.challenge,
              characterExternalId: late.link.characterExternalId,
            }),
          )
        ).payload,
      ).toMatchObject({ reason: 'EXPIRED_CHALLENGE' });
    });
    it('applies profession experience once per eventId, from the session server only', async () => {
      const p = await party();
      await http()
        .post(`/api/v1/player/me/characters/${p.link}/profession`)
        .auth(p.session.accessToken, { type: 'bearer' })
        .send({ profession: 'MINER' })
        .expect(201);
      const xp = async () =>
        Number(
          (
            await one(
              'SELECT experience FROM character_professions WHERE game_server_id = $1 AND character_external_id = $2',
              [server.id, p.char],
            )
          ).experience,
        );
      const home = await agent(server);
      const foreign = await agent(other);
      const eventId = randomUUID();
      const data = { characterExternalId: p.char, amount: 50 };
      const first = home.event('PROFESSION_EXPERIENCE', data, eventId);
      expect(await home.reply(first)).toMatchObject(ack(first));
      expect(await xp()).toBe(50);
      for (let i = 0; i < 3; i++)
        expect(
          (await home.reply(home.event('PROFESSION_EXPERIENCE', data, eventId)))
            .payload,
        ).toMatchObject({ duplicate: true });
      expect(await xp()).toBe(50);
      expect(
        (
          await home.reply(
            home.event(
              'PROFESSION_EXPERIENCE',
              { ...data, amount: 60 },
              eventId,
            ),
          )
        ).payload,
      ).toMatchObject({ code: 'EVENT_CONFLICT' });
      // The same character id on another server is another identity.
      expect(
        (await foreign.reply(foreign.event('PROFESSION_EXPERIENCE', data)))
          .payload,
      ).toMatchObject({ reason: 'PROFESSION_NOT_SELECTED' });
      // No final level, player or reward: only the gameplay fact.
      for (const extra of [
        { level: 99 },
        { playerId: p.session.player.id },
        { profession: 'COOK' },
      ])
        expect(
          (
            await home.reply(
              home.event('PROFESSION_EXPERIENCE', { ...data, ...extra }),
            )
          ).payload,
        ).toMatchObject({ code: 'INVALID_MESSAGE' });
      for (const amount of [0, -5, 1.5])
        expect(
          (
            await home.reply(
              home.event('PROFESSION_EXPERIENCE', { ...data, amount }),
            )
          ).payload,
        ).toMatchObject({ code: 'INVALID_MESSAGE' });
      expect(
        (
          await home.reply(
            home.event('PROFESSION_EXPERIENCE', {
              characterExternalId: 'char:unknown',
              amount: 5,
            }),
          )
        ).payload,
      ).toMatchObject({ reason: 'PROFESSION_NOT_SELECTED' });
      // A final refusal is final for its eventId, even if it could apply later.
      const refused = randomUUID();
      const later = { characterExternalId: `char:${randomUUID()}`, amount: 7 };
      await home.reply(home.event('PROFESSION_EXPERIENCE', later, refused));
      expect(
        (await home.reply(home.event('PROFESSION_EXPERIENCE', later, refused)))
          .payload,
      ).toMatchObject({ reason: 'PROFESSION_NOT_SELECTED' });
      // Concurrent deliveries of one event: one effect.
      const racing = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 5 }, () =>
          home.reply(
            home.event('PROFESSION_EXPERIENCE', { ...data, amount: 5 }, racing),
          ),
        ),
      );
      expect(replies.every((r) => r.type === 'DOMAIN_EVENT_ACK')).toBe(true);
      expect(await xp()).toBe(55);
      expect(await receipts(racing)).toHaveLength(1);
      // Backend "restart": the persisted receipt answers without memory.
      expect(
        await app.get(AgentDomainEventService).handle(server.id, {
          eventId: racing,
          kind: 'PROFESSION_EXPERIENCE',
          data: { ...data, amount: 5 },
        }),
      ).toEqual({ type: 'ACK', duplicate: true, status: null });
      expect(await xp()).toBe(55);
    });
    it('settles a GAME_ITEM trade through WORK_SYNC and one DOMAIN_EVENT, on the backend terms', async () => {
      const a = await party(1000);
      const b = await party(500);
      const opened = (
        await player('post', a.session, 'trades', {
          actorCharacterLinkId: a.link,
          targetCharacterId: b.char,
          offer: { gold: 300, items: [{ itemId: 'item:sword', quantity: 1 }] },
        }).expect(201)
      ).body;
      await player('put', b.session, `trades/${opened.tradeId}/offer`, {
        characterLinkId: b.link,
        gold: 0,
        items: [{ itemId: 'item:shield', quantity: 2 }],
      }).expect(200);
      const view = (
        await player(
          'get',
          a.session,
          `trades/${opened.tradeId}?characterLinkId=${a.link}`,
        ).expect(200)
      ).body;
      await player('post', a.session, `trades/${opened.tradeId}/accept`, {
        characterLinkId: a.link,
        counterpartyOfferVersion: view.target.offer.version,
      }).expect(200);
      const locked = (
        await player('post', b.session, `trades/${opened.tradeId}/accept`, {
          characterLinkId: b.link,
          counterpartyOfferVersion: view.initiator.offer.version,
        }).expect(200)
      ).body;
      expect(locked.status).toBe('AWAITING_GAME_CONFIRMATION');
      const key = await credential(server.id);
      const home = await agent(server, GIVE_CAPS, { key });
      const foreign = await agent(other);
      // Only the owning server's Agent sees the work.
      expect(work(await foreign.syncAll())).toEqual([]);
      const items = work(await home.syncAll(), 'TRADE_SETTLEMENT');
      expect(items).toEqual([
        {
          workId: opened.tradeId,
          kind: 'TRADE_SETTLEMENT',
          createdAt: expect.any(String),
          data: {
            tradeId: opened.tradeId,
            initiatorCharacterId: a.char,
            targetCharacterId: b.char,
            initiatorItems: [
              { type: 'GAME_ITEM', itemExternalId: 'item:sword', quantity: 1 },
            ],
            targetItems: [
              { type: 'GAME_ITEM', itemExternalId: 'item:shield', quantity: 2 },
            ],
          },
        },
      ]);
      // Work carries no economic term the Agent could change.
      expect(JSON.stringify(items)).not.toMatch(/gold|price|amount/i);
      // Another server's Agent cannot complete it: closed, nothing changes.
      foreign.event('TRADE_SETTLEMENT', {
        workId: opened.tradeId,
        outcome: 'SETTLED',
      });
      expect(await foreign.client.closedWith()).toEqual({
        code: 4010,
        reason: 'SERVER_MISMATCH',
      });
      // Nor choose terms.
      for (const extra of [
        { gold: 1 },
        { items: [] },
        { targetCharacterId: 'x' },
      ])
        expect(
          (
            await home.reply(
              home.event('TRADE_SETTLEMENT', {
                workId: opened.tradeId,
                outcome: 'SETTLED',
                ...extra,
              }),
            )
          ).payload,
        ).toMatchObject({ code: 'INVALID_MESSAGE' });
      expect(
        (
          await one('SELECT status FROM player_trades WHERE id = $1', [
            opened.tradeId,
          ])
        ).status,
      ).toBe('AWAITING_GAME_CONFIRMATION');
      expect(await balance(a.char)).toBe(700);
      expect(await balance(b.char)).toBe(500);
      const journal = new FakeTradeJournal();
      expect(journal.fulfill(home, items[0], 1)).toBeUndefined();
      expect([...journal.effects.values()]).toEqual([1]);
      await home.close();
      const resumed = await agent(server, GIVE_CAPS, { key });
      const pending = work(await resumed.syncAll(), 'TRADE_SETTLEMENT');
      expect(pending).toEqual(items);
      expect(
        await one('SELECT status FROM player_trades WHERE id = $1', [
          opened.tradeId,
        ]),
      ).toEqual({ status: 'AWAITING_GAME_CONFIRMATION' });
      expect(await balance(b.char)).toBe(500);
      expect(
        await one(
          'SELECT status FROM player_trade_currency_escrows WHERE trade_id = $1',
          [opened.tradeId],
        ),
      ).toEqual({ status: 'RESERVED' });
      const settled = journal.fulfill(resumed, pending[0])!;
      const eventId = journal.eventIds.get(opened.tradeId)!;
      expect([...journal.effects.values()]).toEqual([1, 1]);
      expect(await resumed.reply(settled)).toMatchObject(ack(settled));
      expect(
        (
          await one('SELECT status FROM player_trades WHERE id = $1', [
            opened.tradeId,
          ])
        ).status,
      ).toBe('COMPLETED');
      // GOLD moved exactly as the backend offer said.
      expect(await balance(a.char)).toBe(700);
      expect(await balance(b.char)).toBe(800);
      // Retry after a reconnect: journal replays success, no physical effect.
      await resumed.close();
      const back = await agent(server, GIVE_CAPS, { key });
      expect(
        (await back.reply(journal.fulfill(back, items[0])!)).payload,
      ).toMatchObject({ duplicate: true });
      expect([...journal.effects.values()]).toEqual([1, 1]);
      expect(await receipts(eventId)).toHaveLength(1);
      expect(await balance(a.char)).toBe(700);
      expect(await balance(b.char)).toBe(800);
      // Completed work is no longer listed.
      expect(work(await back.syncAll(), 'TRADE_SETTLEMENT')).toEqual([]);
      // The domain's realtime/Audit policy is unchanged: one settlement Audit.
      expect(
        await database.query(
          "SELECT action, actor_system_source FROM audit_logs WHERE resource_id = $1 AND action = 'PLAYER_TRADE_SETTLED'",
          [opened.tradeId],
        ),
      ).toEqual([
        { action: 'PLAYER_TRADE_SETTLED', actor_system_source: 'AGENT' },
      ]);
    });
    it('runs marketplace custody, purchase settlement and item release as typed work', async () => {
      const seller = await party();
      const buyer = await party(1000);
      const listed = (
        await player('post', seller.session, 'marketplace/listings', {
          characterLinkId: seller.link,
          itemId: 'item:bow',
          quantity: 3,
          priceGold: 250,
        }).expect(201)
      ).body;
      const home = await agent(server);
      const foreign = await agent(other);
      const custody = work(await home.syncAll({ kind: 'MARKETPLACE_CUSTODY' }));
      expect(custody).toEqual([
        {
          workId: listed.listingId,
          kind: 'MARKETPLACE_CUSTODY',
          createdAt: expect.any(String),
          data: {
            listingId: listed.listingId,
            sellerCharacterId: seller.char,
            itemExternalId: 'item:bow',
            quantity: 3,
          },
        },
      ]);
      expect(JSON.stringify(custody)).not.toMatch(/price|gold/i);
      // The Agent cannot set item, quantity, seller or price.
      for (const extra of [
        { quantity: 1 },
        { itemExternalId: 'item:x' },
        { priceGold: 1 },
        { sellerCharacterId: buyer.char },
      ])
        expect(
          (
            await home.reply(
              home.event('MARKETPLACE_CUSTODY', {
                workId: listed.listingId,
                outcome: 'CUSTODIED',
                ...extra,
              }),
            )
          ).payload,
        ).toMatchObject({ code: 'INVALID_MESSAGE' });
      const custodied = home.event('MARKETPLACE_CUSTODY', {
        workId: listed.listingId,
        outcome: 'CUSTODIED',
      });
      expect(await home.reply(custodied)).toMatchObject(ack(custodied));
      const listing = async (id: string) =>
        one('SELECT status FROM player_marketplace_listings WHERE id = $1', [
          id,
        ]);
      expect((await listing(listed.listingId)).status).toBe('ACTIVE');
      const purchase = (
        await player(
          'post',
          buyer.session,
          `marketplace/listings/${listed.listingId}/purchase`,
          { characterLinkId: buyer.link },
        ).expect(201)
      ).body;
      const settlement = work(
        await home.syncAll({ kind: 'MARKETPLACE_SETTLEMENT' }),
      );
      expect(settlement).toMatchObject([
        {
          workId: purchase.purchaseId,
          data: {
            purchaseId: purchase.purchaseId,
            listingId: listed.listingId,
            buyerCharacterId: buyer.char,
            sellerCharacterId: seller.char,
            itemExternalId: 'item:bow',
            quantity: 3,
          },
        },
      ]);
      // Another server's Agent: closed, no economic effect.
      foreign.event('MARKETPLACE_SETTLEMENT', {
        workId: purchase.purchaseId,
        outcome: 'SETTLED',
      });
      expect((await foreign.client.closedWith()).code).toBe(4010);
      expect(await balance(seller.char)).toBe(0);
      const settled = home.event('MARKETPLACE_SETTLEMENT', {
        workId: purchase.purchaseId,
        outcome: 'SETTLED',
      });
      expect(await home.reply(settled)).toMatchObject(ack(settled));
      expect((await listing(listed.listingId)).status).toBe('SOLD');
      // The price comes from the listing, not the event.
      expect(await balance(seller.char)).toBe(250);
      expect(await balance(buyer.char)).toBe(750);
      expect(
        work(await home.syncAll({ kind: 'MARKETPLACE_SETTLEMENT' })),
      ).toEqual([]);

      // Cancel of an ACTIVE listing: the item's return is tracked.
      const again = (
        await player('post', seller.session, 'marketplace/listings', {
          characterLinkId: seller.link,
          itemId: 'item:arrow',
          quantity: 20,
          priceGold: 40,
        }).expect(201)
      ).body;
      await home.reply(
        home.event('MARKETPLACE_CUSTODY', {
          workId: again.listingId,
          outcome: 'CUSTODIED',
        }),
      );
      await player(
        'post',
        seller.session,
        `marketplace/listings/${again.listingId}/cancel`,
        { characterLinkId: seller.link },
      ).expect(200);
      expect((await listing(again.listingId)).status).toBe('CANCELLED');
      const release = await one(
        'SELECT * FROM player_marketplace_item_releases WHERE listing_id = $1',
        [again.listingId],
      );
      expect(release).toMatchObject({
        game_server_id: server.id,
        seller_character_id: seller.char,
        reason: 'CANCELLED',
        status: 'PENDING',
      });
      // It survives reconnects: the same workId comes back.
      await home.close();
      const back = await agent(server);
      const releases = work(
        await back.syncAll({ kind: 'MARKETPLACE_RELEASE' }),
      );
      expect(releases).toEqual([
        {
          workId: release.id,
          kind: 'MARKETPLACE_RELEASE',
          createdAt: expect.any(String),
          data: {
            releaseId: release.id,
            listingId: again.listingId,
            sellerCharacterId: seller.char,
            itemExternalId: 'item:arrow',
            quantity: 20,
          },
        },
      ]);
      const other2 = await agent(other);
      other2.event('MARKETPLACE_RELEASE', {
        workId: release.id,
        outcome: 'RELEASED',
      });
      expect((await other2.client.closedWith()).code).toBe(4010);
      const eventId = randomUUID();
      const released = back.event(
        'MARKETPLACE_RELEASE',
        { workId: release.id, outcome: 'RELEASED' },
        eventId,
      );
      expect(await back.reply(released)).toMatchObject(ack(released));
      expect(
        await one(
          'SELECT status, release_event_id, error_code FROM player_marketplace_item_releases WHERE id = $1',
          [release.id],
        ),
      ).toEqual({
        status: 'COMPLETED',
        release_event_id: eventId,
        error_code: null,
      });
      expect(
        (
          await back.reply(
            back.event(
              'MARKETPLACE_RELEASE',
              { workId: release.id, outcome: 'RELEASED' },
              eventId,
            ),
          )
        ).payload,
      ).toMatchObject({ duplicate: true });
      // Another event cannot reopen or change it.
      expect(
        (
          await back.reply(
            back.event('MARKETPLACE_RELEASE', {
              workId: release.id,
              outcome: 'FAILED',
            }),
          )
        ).payload,
      ).toMatchObject({ reason: 'RELEASE_NOT_PENDING' });
      expect(work(await back.syncAll({ kind: 'MARKETPLACE_RELEASE' }))).toEqual(
        [],
      );

      // A failed purchase settlement also returns the item to the seller.
      const third = (
        await player('post', seller.session, 'marketplace/listings', {
          characterLinkId: seller.link,
          itemId: 'item:helm',
          quantity: 1,
          priceGold: 100,
        }).expect(201)
      ).body;
      await back.reply(
        back.event('MARKETPLACE_CUSTODY', {
          workId: third.listingId,
          outcome: 'CUSTODIED',
        }),
      );
      const bought = (
        await player(
          'post',
          buyer.session,
          `marketplace/listings/${third.listingId}/purchase`,
          { characterLinkId: buyer.link },
        ).expect(201)
      ).body;
      await back.reply(
        back.event('MARKETPLACE_SETTLEMENT', {
          workId: bought.purchaseId,
          outcome: 'FAILED',
        }),
      );
      expect(await balance(buyer.char)).toBe(750);
      expect(
        await one(
          'SELECT reason, status FROM player_marketplace_item_releases WHERE listing_id = $1',
          [third.listingId],
        ),
      ).toEqual({ reason: 'PURCHASE_FAILED', status: 'PENDING' });
    });
    it.each(['CANCELLED', 'FAILED'] as const)(
      'persists late acquired custody after %s, deduplicates and recovers release',
      async (terminal) => {
        const seller = await party();
        const home = await agent(server);
        const listing = (
          await player('post', seller.session, 'marketplace/listings', {
            characterLinkId: seller.link,
            itemId: 'item:late',
            quantity: 1,
            priceGold: 10,
          }).expect(201)
        ).body;
        const workId = listing.listingId;
        expect(
          work(await home.syncAll({ kind: 'MARKETPLACE_CUSTODY' })).map(
            (w) => w.workId,
          ),
        ).toContain(workId);
        // The Agent acquired the item but its success is still in flight.
        if (terminal === 'CANCELLED')
          await player(
            'post',
            seller.session,
            `marketplace/listings/${workId}/cancel`,
            {
              characterLinkId: seller.link,
            },
          ).expect(200);
        else
          await home.reply(
            home.event('MARKETPLACE_CUSTODY', { workId, outcome: 'FAILED' }),
          );
        const releases = () =>
          database.query(
            'SELECT * FROM player_marketplace_item_releases WHERE listing_id = $1',
            [workId],
          );
        expect(await releases()).toEqual([]); // No acquired custody report, no release.
        const before = await one(
          'SELECT * FROM player_marketplace_listings WHERE id = $1',
          [workId],
        );
        const foreign = await agent(other);
        foreign.event('MARKETPLACE_CUSTODY', { workId, outcome: 'SUCCEEDED' });
        expect(await foreign.client.closedWith()).toEqual({
          code: 4010,
          reason: 'SERVER_MISMATCH',
        });
        expect(await releases()).toEqual([]);
        expect(
          await one('SELECT * FROM player_marketplace_listings WHERE id = $1', [
            workId,
          ]),
        ).toEqual(before);
        const eventId = randomUUID();
        const data = { workId, outcome: 'SUCCEEDED' };
        const sent = home.event('MARKETPLACE_CUSTODY', data, eventId);
        expect(await home.reply(sent)).toMatchObject(ack(sent));
        expect(
          (await home.reply(home.event('MARKETPLACE_CUSTODY', data, eventId)))
            .payload,
        ).toMatchObject({ duplicate: true });
        const equivalent = await Promise.all(
          Array.from({ length: 3 }, () =>
            home.reply(home.event('MARKETPLACE_CUSTODY', data)),
          ),
        );
        expect(equivalent.every((r) => r.type === 'DOMAIN_EVENT_ACK')).toBe(
          true,
        );
        expect(
          await one('SELECT * FROM player_marketplace_listings WHERE id = $1', [
            workId,
          ]),
        ).toEqual(before);
        const rows = await releases();
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('PENDING');
        expect(
          work(await home.syncAll({ kind: 'MARKETPLACE_CUSTODY' })).map(
            (w) => w.workId,
          ),
        ).not.toContain(workId);
        const pending = work(
          await home.syncAll({ kind: 'MARKETPLACE_RELEASE' }),
        ).find((w) => w.workId === rows[0].id);
        expect(pending).toBeDefined();
        await home.close();
        const back = await agent(server);
        expect(
          work(await back.syncAll({ kind: 'MARKETPLACE_RELEASE' })),
        ).toContainEqual(pending);
        const returned = back.event('MARKETPLACE_RELEASE', {
          workId: rows[0].id,
          outcome: 'RELEASED',
        });
        expect(await back.reply(returned)).toMatchObject(ack(returned));
        expect((await releases())[0].status).toBe('COMPLETED');
        // A new custody event after the return must not create/reopen a release.
        await back.reply(back.event('MARKETPLACE_CUSTODY', data));
        expect(await releases()).toHaveLength(1);
        expect((await releases())[0].status).toBe('COMPLETED');
        expect(
          work(await back.syncAll({ kind: 'MARKETPLACE_RELEASE' })).map(
            (w) => w.workId,
          ),
        ).not.toContain(rows[0].id);
      },
    );
    it('pages WORK_SYNC with a stable cursor, per server, and pushes new work best-effort', async () => {
      const seller = await party();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push(
          (
            await player('post', seller.session, 'marketplace/listings', {
              characterLinkId: seller.link,
              itemId: `item:${i}`,
              quantity: 1,
              priceGold: 10,
            }).expect(201)
          ).body.listingId,
        );
      const foreignSeller = await party(0, other);
      await player('post', foreignSeller.session, 'marketplace/listings', {
        characterLinkId: foreignSeller.link,
        itemId: 'item:foreign',
        quantity: 1,
        priceGold: 10,
      }).expect(201);
      const home = await agent(server);
      const pages = await home.syncAll({ limit: 2 });
      expect(pages.length).toBeGreaterThanOrEqual(3);
      for (const page of pages)
        expect((page.payload!.items as unknown[]).length).toBeLessThanOrEqual(
          2,
        );
      const seen = work(pages).map((i) => i.workId);
      expect(seen).toEqual(ids);
      // Reconnect: the same work with the same workIds, nothing lost.
      await home.close();
      const back = await agent(server);
      expect(work(await back.syncAll()).map((i) => i.workId)).toEqual(ids);
      // Repeating WORK_SYNC changes nothing.
      expect(work(await back.syncAll()).map((i) => i.workId)).toEqual(ids);
      // Invalid cursors and requests are refused.
      for (const bad of [
        { cursor: 'not-a-cursor' },
        { cursor: Buffer.from('[9,null,null]').toString('base64url') },
        { limit: 51 },
        { kind: 'ARBITRARY_WORK' },
        { gameServerId: server.id },
      ])
        expect((await back.sync(bad)).payload).toMatchObject({
          code: 'INVALID_MESSAGE',
        });
      // Completed work disappears.
      await back.reply(
        back.event('MARKETPLACE_CUSTODY', {
          workId: ids[0],
          outcome: 'FAILED',
        }),
      );
      expect(work(await back.syncAll()).map((i) => i.workId)).toEqual(
        ids.slice(1),
      );
      // Live push: new work arrives without asking, and only once.
      const fresh = (
        await player('post', seller.session, 'marketplace/listings', {
          characterLinkId: seller.link,
          itemId: 'item:new',
          quantity: 1,
          priceGold: 10,
        }).expect(201)
      ).body.listingId;
      await eventually(async () =>
        back
          .pushes()
          .some((p) =>
            (p.payload!.items as { workId: string }[]).some(
              (i) => i.workId === fresh,
            ),
          ),
      );
      await pause(400);
      const told = back
        .pushes()
        .flatMap((p) => p.payload!.items as { workId: string }[])
        .filter((i) => i.workId === fresh);
      expect(told).toHaveLength(1);
    });
    it('delivers CHARACTER VIP rewards through SYSTEM:VIP_DELIVERY GameCommands, never guessing a character', async () => {
      const offer = async (scope: 'PLAYER' | 'CHARACTER', rewards: object[]) =>
        (
          await http()
            .post('/api/v1/admin/vip-store/offers')
            .auth(staffToken, { type: 'bearer' })
            .send({
              code: `vip_${randomUUID().slice(0, 8)}`,
              name: 'VIP',
              description: 'Benefit',
              priceMinor: 990,
              currency: 'BRL',
              rewards,
              entitlementScope: scope,
              active: true,
            })
            .expect(201)
        ).body as { id: string };
      const entitlements = app.get(VipEntitlementService);
      const system = systemActor(SystemSource.VIP_DELIVERY);
      const grant = async (offerId: string, char: string) => {
        const result = await entitlements.grant({
          offerId,
          target: {
            scope: VipEntitlementScope.CHARACTER,
            gameServerId: server.id,
            characterExternalId: char,
          },
          actor: system,
          idempotencyKey: randomUUID(),
        });
        expect(result.outcome).toBe('GRANTED');
        return (result as { entitlementId: string }).entitlementId;
      };
      const deliveries = (entitlementId: string) =>
        database.query(
          'SELECT * FROM vip_reward_deliveries WHERE entitlement_id = $1 ORDER BY reward_index',
          [entitlementId],
        );
      const product = await offer('CHARACTER', [
        { type: 'ITEM', itemId: 'item:potion', quantity: 5 },
        { type: 'TITLE', titleId: 'title:hero' },
      ]);
      // PLAYER rights never pick a character (first, last, newest...).
      const p = await party();
      const account = await offer('PLAYER', [
        { type: 'TITLE', titleId: 'title:vip' },
      ]);
      const accountRight = await entitlements.grant({
        offerId: account.id,
        target: {
          scope: VipEntitlementScope.PLAYER,
          playerId: p.session.player.id,
        },
        actor: system,
        idempotencyKey: randomUUID(),
      });
      expect(
        await deliveries(
          (accountRight as { entitlementId: string }).entitlementId,
        ),
      ).toEqual([]);

      // Revoked before any command (Agent offline): never delivered.
      const early = await grant(product.id, `char:${randomUUID()}`);
      expect(
        (await deliveries(early)).map((d: { status: string }) => d.status),
      ).toEqual(['PENDING', 'PENDING']);
      await pause(300);
      expect((await deliveries(early))[0].game_command_id).toBeNull();
      await entitlements.revoke({
        entitlementId: early,
        actor: system,
        idempotencyKey: randomUUID(),
      });
      const host = await agent(server, GIVE_CAPS);
      await eventually(async () =>
        (await deliveries(early)).every(
          (d: { status: string }) => d.status === 'CANCELLED',
        ),
      );
      expect(
        (await deliveries(early)).map(
          (d: { error_code: string }) => d.error_code,
        ),
      ).toEqual(['ENTITLEMENT_REVOKED', 'ENTITLEMENT_REVOKED']);

      // Delivered with the Agent ready: one command per reward.
      const char = `char:${randomUUID()}`;
      const right = await grant(product.id, char);
      const created = await eventually(async () => {
        const rows = await deliveries(right);
        return (
          rows.every(
            (d: { status: string }) => d.status === 'COMMAND_CREATED',
          ) && rows
        );
      });
      const commands = await database.query(
        'SELECT id, type, payload, actor_type, requested_by_system_source FROM game_commands WHERE id = ANY($1::uuid[]) ORDER BY type',
        [created.map((d: { game_command_id: string }) => d.game_command_id)],
      );
      expect(commands).toMatchObject([
        {
          type: 'CHARACTER_ITEM_GIVE',
          payload: { characterId: char, itemId: 'item:potion', quantity: 5 },
          actor_type: 'SYSTEM',
          requested_by_system_source: 'VIP_DELIVERY',
        },
        {
          type: 'CHARACTER_TITLE_GIVE',
          payload: { characterId: char, titleId: 'title:hero' },
          actor_type: 'SYSTEM',
          requested_by_system_source: 'VIP_DELIVERY',
        },
      ]);
      // Revoked after the command: no clawback, the command runs its course.
      await entitlements.revoke({
        entitlementId: right,
        actor: system,
        idempotencyKey: randomUUID(),
      });
      const [item, title] = commands as { id: string }[];
      for (const [command, outcome] of [
        [
          item,
          {
            outcome: 'SUCCEEDED',
            result: {
              characterId: char,
              applied: true,
              targetId: 'item:potion',
            },
          },
        ],
        [title, { outcome: 'UNCERTAIN' }],
      ] as const) {
        const sent = await host.command(command.id);
        host.ack(sent);
        await host.reply(host.result(sent.payload!, outcome));
      }
      await eventually(async () => {
        const rows = await deliveries(right);
        return rows[0].status === 'SUCCEEDED' && rows[1].status === 'UNCERTAIN';
      });
      expect((await deliveries(right))[1].error_code).toBe(
        'EXECUTION_UNCERTAIN',
      );
      // Never a second command, whatever the ticks.
      await pause(400);
      expect(
        (
          await one(
            "SELECT count(*)::int AS n FROM game_commands WHERE requested_by_system_source = 'VIP_DELIVERY' AND payload->>'characterId' = $1",
            [char],
          )
        ).n,
      ).toBe(2);
      expect(host.commands(item.id).length).toBeGreaterThanOrEqual(1);

      // A definite failure is FAILED, with the command's code.
      const failing = await grant(
        (await offer('CHARACTER', [{ type: 'TITLE', titleId: 'title:x' }])).id,
        `char:${randomUUID()}`,
      );
      const [row] = await eventually(async () => {
        const rows = await deliveries(failing);
        return rows[0].game_command_id && rows;
      });
      const sent = await host.command(row.game_command_id);
      host.ack(sent);
      await host.reply(
        host.result(sent.payload!, {
          outcome: 'FAILED',
          errorCode: 'EXECUTION_FAILED',
        }),
      );
      await eventually(
        async () => (await deliveries(failing))[0].status === 'FAILED',
      );
      expect((await deliveries(failing))[0].error_code).toBe(
        'EXECUTION_FAILED',
      );

      // Reconciliation is rebuilt from game_command_id alone (restart).
      const worker = app.get(VipDeliveryService);
      await database.query(
        "UPDATE vip_reward_deliveries SET status = 'COMMAND_CREATED', error_code = NULL, completed_at = NULL WHERE entitlement_id = $1",
        [failing],
      );
      await worker.reconcile();
      expect((await deliveries(failing))[0]).toMatchObject({
        status: 'FAILED',
        error_code: 'EXECUTION_FAILED',
      });
    });
    it('migrates: refuses to forget open obligations, reverts, backfills custodied releases and reapplies', async () => {
      const tables = () =>
        database.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename IN ('agent_domain_event_receipts', 'player_marketplace_item_releases', 'vip_reward_deliveries') ORDER BY tablename",
          [schema],
        );
      expect(await tables()).toHaveLength(3);
      expect(database.options.synchronize).toBe(false);
      expect(
        (await database.driver.createSchemaBuilder().log()).upQueries,
      ).toEqual([]);
      await database.undoLastMigration(); // Etapa 12.4 Operational Recovery
      // Earlier tests left a PENDING release: a held item is never forgotten.
      await expect(database.undoLastMigration()).rejects.toThrow(
        'Pending marketplace item releases or VIP reward deliveries exist',
      );
      await database.query(
        "UPDATE player_marketplace_item_releases SET status = 'COMPLETED', release_event_id = gen_random_uuid(), completed_at = now() WHERE status = 'PENDING'",
      );
      await database.query(
        "UPDATE vip_reward_deliveries SET status = 'CANCELLED', error_code = 'ENTITLEMENT_REVOKED', completed_at = now(), game_command_id = NULL WHERE status IN ('PENDING', 'COMMAND_CREATED')",
      );
      await database.undoLastMigration();
      expect(await tables()).toEqual([]);
      // Etapa 10.14 data: a listing cancelled while its item was custodied.
      const seller = await party();
      const listed = (
        await player('post', seller.session, 'marketplace/listings', {
          characterLinkId: seller.link,
          itemId: 'item:legacy',
          quantity: 2,
          priceGold: 30,
        }).expect(201)
      ).body;
      await database.query(
        "INSERT INTO player_marketplace_custody_events(game_server_id, custody_event_id, listing_id, outcome) VALUES ($1, 'legacy-custody', $2, 'CUSTODIED')",
        [server.id, listed.listingId],
      );
      await database.query(
        "UPDATE player_marketplace_listings SET status = 'CANCELLED', custody_event_id = 'legacy-custody', cancelled_at = now() WHERE id = $1",
        [listed.listingId],
      );
      expect(await database.runMigrations()).toHaveLength(2);
      expect(await database.runMigrations()).toHaveLength(0);
      expect(
        await one(
          'SELECT game_server_id, seller_character_id, reason, status FROM player_marketplace_item_releases WHERE listing_id = $1',
          [listed.listingId],
        ),
      ).toEqual({
        game_server_id: server.id,
        seller_character_id: seller.char,
        reason: 'CANCELLED',
        status: 'PENDING',
      });
      expect(await database.query('SELECT * FROM migrations')).toHaveLength(26);
      expect(await database.showMigrations()).toBe(false);
      expect(
        (await database.driver.createSchemaBuilder().log()).upQueries,
      ).toEqual([]);
      // The backfilled release is ordinary work of its server.
      const home = await agent(server);
      expect(
        work(await home.syncAll({ kind: 'MARKETPLACE_RELEASE' })).map(
          (i) => (i.data as { listingId: string }).listingId,
        ),
      ).toEqual([listed.listingId]);
    });
    it('keeps the receipt and the domain effect atomic, with no Audit of its own', async () => {
      const p = await party();
      await http()
        .post(`/api/v1/player/me/characters/${p.link}/profession`)
        .auth(p.session.accessToken, { type: 'bearer' })
        .send({ profession: 'MINER' })
        .expect(201);
      const home = await agent(server);
      // A receipt write that fails rolls the grant back: no effect, no receipt.
      await database.query(
        "ALTER TABLE agent_domain_event_receipts ADD CONSTRAINT receipt_failure CHECK (kind <> 'PROFESSION_EXPERIENCE') NOT VALID",
      );
      const eventId = randomUUID();
      try {
        expect(
          (
            await home.reply(
              home.event(
                'PROFESSION_EXPERIENCE',
                { characterExternalId: p.char, amount: 9 },
                eventId,
              ),
            )
          ).payload,
        ).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });
        expect(
          await database.query(
            'SELECT * FROM profession_experience_events WHERE external_event_id = $1',
            [eventId],
          ),
        ).toEqual([]);
        expect(await receipts(eventId)).toEqual([]);
      } finally {
        await database.query(
          'ALTER TABLE agent_domain_event_receipts DROP CONSTRAINT receipt_failure',
        );
      }
      // The retry of the same eventId then applies exactly once.
      const retry = home.event(
        'PROFESSION_EXPERIENCE',
        { characterExternalId: p.char, amount: 9 },
        eventId,
      );
      expect(await home.reply(retry)).toMatchObject(ack(retry));
      expect(await receipts(eventId)).toHaveLength(1);
      // The domain Audit stays the only Audit (none for the transport).
      expect(
        await database.query(
          "SELECT action FROM audit_logs WHERE metadata->>'externalEventId' = $1",
          [eventId],
        ),
      ).toEqual([{ action: 'PROFESSION_EXPERIENCE_GRANTED' }]);
      // Unknown kinds and generic events do not exist.
      for (const payload of [
        { eventId: randomUUID(), kind: 'GENERIC', data: {} },
        {
          eventId: randomUUID(),
          kind: 'ENTITY_CHANGED',
          data: { entity: 'player', action: 'update', payload: {} },
        },
        { eventId: randomUUID(), kind: 'GOLD_GRANT', data: { amount: 1 } },
        { eventId: 'x', kind: 'PROFESSION_EXPERIENCE', data: {} },
      ])
        expect(
          (await home.reply(home.send('DOMAIN_EVENT', payload))).payload,
        ).toMatchObject({ code: 'INVALID_MESSAGE' });
    });
  },
);
