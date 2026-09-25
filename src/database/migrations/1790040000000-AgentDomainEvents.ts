import type { MigrationInterface, QueryRunner } from 'typeorm';

// Etapa 11.4: Host Agent domain events and gameplay work.
// - agent_domain_event_receipts: durable, uniform DOMAIN_EVENT dedup by
//   (session server, eventId); content hash only, never the payload.
// - player_marketplace_item_releases: return of a custodied listing item to
//   its seller, tracked until the Agent reports it. Listings already ended
//   (CANCELLED/FAILED) while the Agent held their item get a PENDING release.
// - vip_reward_deliveries: one row per reward of a CHARACTER entitlement,
//   delivered through one GameCommand. Entitlements granted before 11.4 get
//   no delivery here (no reward snapshot existed; see docs).
export class AgentDomainEvents1790040000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE agent_domain_event_receipts (
        game_server_id uuid NOT NULL,
        event_id uuid NOT NULL,
        kind varchar(48) NOT NULL,
        content_hash char(64) NOT NULL,
        status varchar(16) NOT NULL,
        reason varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT agent_domain_event_receipts_pkey PRIMARY KEY (game_server_id, event_id),
        CONSTRAINT agent_domain_event_receipts_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT agent_domain_event_receipts_kind_check CHECK (kind IN ('CHARACTER_OWNERSHIP_PROOF', 'PROFESSION_EXPERIENCE', 'TRADE_SETTLEMENT', 'MARKETPLACE_CUSTODY', 'MARKETPLACE_SETTLEMENT', 'MARKETPLACE_RELEASE')),
        CONSTRAINT agent_domain_event_receipts_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT agent_domain_event_receipts_status_check CHECK ((status = 'APPLIED' AND reason IS NULL) OR (status = 'REJECTED' AND reason IS NOT NULL))
      );

      CREATE TABLE player_marketplace_item_releases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        seller_character_id varchar(128) NOT NULL,
        reason varchar(16) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        release_event_id uuid,
        error_code varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT player_marketplace_item_releases_listing_fkey FOREIGN KEY (listing_id) REFERENCES player_marketplace_listings(id),
        CONSTRAINT player_marketplace_item_releases_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_marketplace_item_releases_listing_key UNIQUE (listing_id),
        CONSTRAINT player_marketplace_item_releases_event_key UNIQUE (game_server_id, release_event_id),
        CONSTRAINT player_marketplace_item_releases_status_check CHECK ((status = 'PENDING' AND completed_at IS NULL AND release_event_id IS NULL AND error_code IS NULL) OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND release_event_id IS NOT NULL AND error_code IS NULL) OR (status = 'FAILED' AND completed_at IS NOT NULL AND release_event_id IS NOT NULL AND error_code IS NOT NULL)),
        CONSTRAINT player_marketplace_item_releases_reason_check CHECK (reason IN ('CANCELLED', 'PURCHASE_FAILED') AND length(btrim(seller_character_id)) > 0)
      );
      CREATE INDEX player_marketplace_item_releases_work_idx ON player_marketplace_item_releases(game_server_id, status, created_at, id);
      INSERT INTO player_marketplace_item_releases(listing_id, game_server_id, seller_character_id, reason, created_at)
        SELECT l.id, l.game_server_id, l.seller_character_id,
               CASE WHEN l.status = 'CANCELLED' THEN 'CANCELLED' ELSE 'PURCHASE_FAILED' END,
               COALESCE(l.cancelled_at, l.failed_at, now())
        FROM player_marketplace_listings l
        JOIN player_marketplace_custody_events c ON c.listing_id = l.id AND c.outcome = 'CUSTODIED'
        WHERE l.status IN ('CANCELLED', 'FAILED');

      CREATE TABLE vip_reward_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entitlement_id uuid NOT NULL,
        reward_index smallint NOT NULL,
        reward jsonb NOT NULL,
        game_server_id uuid NOT NULL,
        character_external_id varchar(128) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        game_command_id uuid,
        error_code varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT vip_reward_deliveries_entitlement_fkey FOREIGN KEY (entitlement_id) REFERENCES player_vip_entitlements(id),
        CONSTRAINT vip_reward_deliveries_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT vip_reward_deliveries_command_fkey FOREIGN KEY (game_command_id) REFERENCES game_commands(id),
        CONSTRAINT vip_reward_deliveries_reward_key UNIQUE (entitlement_id, reward_index),
        CONSTRAINT vip_reward_deliveries_command_key UNIQUE (game_command_id),
        CONSTRAINT vip_reward_deliveries_status_check CHECK ((status = 'PENDING' AND game_command_id IS NULL AND completed_at IS NULL AND error_code IS NULL) OR (status = 'COMMAND_CREATED' AND game_command_id IS NOT NULL AND completed_at IS NULL AND error_code IS NULL) OR (status = 'SUCCEEDED' AND game_command_id IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL) OR (status IN ('FAILED', 'UNCERTAIN') AND completed_at IS NOT NULL AND error_code IS NOT NULL AND (status = 'FAILED' OR game_command_id IS NOT NULL)) OR (status = 'CANCELLED' AND game_command_id IS NULL AND completed_at IS NOT NULL AND error_code IS NOT NULL)),
        CONSTRAINT vip_reward_deliveries_reward_check CHECK (reward_index BETWEEN 0 AND 19 AND jsonb_typeof(reward) = 'object' AND octet_length(reward::text) <= 4096 AND length(btrim(character_external_id)) > 0)
      );
      CREATE INDEX vip_reward_deliveries_status_idx ON vip_reward_deliveries(status, created_at, id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Open obligations cannot be represented without these tables: a held
    // item still owed to its seller, a reward not yet delivered.
    const [open] = await queryRunner.query(`
      SELECT
        (SELECT count(*) FROM player_marketplace_item_releases WHERE status = 'PENDING')::int AS releases,
        (SELECT count(*) FROM vip_reward_deliveries WHERE status IN ('PENDING', 'COMMAND_CREATED'))::int AS deliveries
    `);
    if (open.releases > 0 || open.deliveries > 0)
      throw new Error(
        'Pending marketplace item releases or VIP reward deliveries exist',
      );
    await queryRunner.query(`
      DROP TABLE vip_reward_deliveries;
      DROP TABLE player_marketplace_item_releases;
      DROP TABLE agent_domain_event_receipts;
    `);
  }
}
