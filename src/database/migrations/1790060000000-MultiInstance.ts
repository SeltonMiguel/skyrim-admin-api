import type { MigrationInterface, QueryRunner } from 'typeorm';

// Subetapa 12.5: PostgreSQL-only coordination of N backend replicas
// (docs/multi-instance.md). Forward-only in production.
// - game_connections.owner_instance_id: the process execution that holds
//   the Host Agent socket. The lease is the existing heartbeat freshness
//   (last_heartbeat_at + GAME_BRIDGE_HEARTBEAT_TIMEOUT_MS), renewed only by
//   the owner; only the owner may dispatch or accept frames. Rows from
//   before this migration have no owner and are never dispatched to.
// - distributed_bus_events: ephemeral envelopes of the LISTEN/NOTIFY bus;
//   NOTIFY carries only the event id. Short TTL, bounded cleanup, no replay.
// - rate_limit_buckets / rate_limit_slots: shared fixed-window counters and
//   keyed sliding-window slots (chat), keyed by SHA-256, never plaintext.
// - realtime_connection_leases: cluster-wide per-principal socket quota.
export class MultiInstance1790060000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE game_connections ADD COLUMN owner_instance_id uuid;
      CREATE INDEX game_connections_owner_idx ON game_connections(owner_instance_id) WHERE status = 'CONNECTED';

      CREATE TABLE distributed_bus_events (
        id uuid PRIMARY KEY,
        kind varchar(48) NOT NULL,
        origin_instance_id uuid NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT distributed_bus_events_check CHECK (kind ~ '^[A-Z][A-Z_]{0,47}$' AND jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536 AND expires_at > created_at)
      );
      CREATE INDEX distributed_bus_events_expiry_idx ON distributed_bus_events(expires_at);

      CREATE TABLE rate_limit_buckets (
        scope varchar(64) NOT NULL,
        key_hash char(64) NOT NULL,
        hits integer NOT NULL,
        window_started_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (scope, key_hash),
        CONSTRAINT rate_limit_buckets_check CHECK (length(scope) > 0 AND key_hash ~ '^[0-9a-f]{64}$' AND hits >= 0 AND expires_at > window_started_at)
      );
      CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets(expires_at);

      CREATE TABLE rate_limit_slots (
        scope varchar(64) NOT NULL,
        key_hash char(64) NOT NULL,
        slot_hash char(64) NOT NULL,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        CONSTRAINT rate_limit_slots_pkey PRIMARY KEY (scope, key_hash, slot_hash),
        CONSTRAINT rate_limit_slots_check CHECK (length(scope) > 0 AND key_hash ~ '^[0-9a-f]{64}$' AND slot_hash ~ '^[0-9a-f]{64}$' AND expires_at > created_at)
      );
      CREATE INDEX rate_limit_slots_expiry_idx ON rate_limit_slots(expires_at);

      CREATE TABLE realtime_connection_leases (
        id uuid PRIMARY KEY,
        surface varchar(8) NOT NULL,
        principal_id uuid NOT NULL,
        session_id uuid,
        instance_id uuid NOT NULL,
        connected_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT realtime_connection_leases_check CHECK (surface IN ('PLAYER', 'STAFF') AND expires_at > connected_at)
      );
      CREATE INDEX realtime_connection_leases_principal_idx ON realtime_connection_leases(surface, principal_id, expires_at);
      CREATE INDEX realtime_connection_leases_instance_idx ON realtime_connection_leases(instance_id);
      CREATE INDEX realtime_connection_leases_expiry_idx ON realtime_connection_leases(expires_at);
    `);
  }

  // Everything added here is ephemeral coordination state: dropping it
  // loses no business record.
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE realtime_connection_leases;
      DROP TABLE rate_limit_slots;
      DROP TABLE rate_limit_buckets;
      DROP TABLE distributed_bus_events;
      DROP INDEX game_connections_owner_idx;
      ALTER TABLE game_connections DROP COLUMN owner_instance_id;
    `);
  }
}
