import type { MigrationInterface, QueryRunner } from 'typeorm';

// Subetapa 12.4: operational recovery without manual SQL. Forward-only in
// production (docs/operational-recovery.md); `down` exists for the test
// chain and refuses to forget operator evidence.
// - Narrow Staff permissions for each recovery domain (fail-closed RBAC).
// - operator_actions: one row per accepted operator intervention, keyed by
//   (staff, Idempotency-Key) with a request fingerprint: a replay returns
//   the stored result, a different request with the same key is refused.
// - Separate resolution columns (never overwriting the original outcome)
//   for Server Control UNCERTAIN, VIP deliveries FAILED/UNCERTAIN and
//   marketplace releases FAILED; each set is all-or-none (CHECK).
// - VIP delivery attempts: a proven pre-effect failure (or an UNCERTAIN
//   confirmed not delivered) may get a new attempt; the finished one is
//   archived in vip_reward_delivery_attempts, never rewritten.
// - Staff GOLD adjustments: ledger type STAFF_ADJUSTMENT (actor STAFF only)
//   against the SYSTEM ADJUSTMENT account; no "set balance" exists.
// - Chat moderation hides a message (moderated_*), never deletes it: the
//   history trigger allows exactly that one update.
// - agent_work_rejections: last Agent rejection per work item (kind,
//   workId), reason only, never the payload.
export class OperationalRecovery1790050000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions(name) VALUES
        ('OPERATIONS_READ'), ('SERVER_CONTROL_RESOLVE'), ('PLAYER_TRADE_RECOVER'),
        ('PLAYER_MARKETPLACE_RECOVER'), ('VIP_DELIVERY_RECOVER'), ('PLAYER_ACCOUNT_MODERATE'),
        ('PLAYER_ECONOMY_ADJUST'), ('PLAYER_CHAT_MODERATE');
      INSERT INTO role_permissions(role_name, permission_name) VALUES
        ('COORDINATOR', 'OPERATIONS_READ'), ('COORDINATOR', 'SERVER_CONTROL_RESOLVE'),
        ('COORDINATOR', 'PLAYER_TRADE_RECOVER'), ('COORDINATOR', 'PLAYER_MARKETPLACE_RECOVER'),
        ('COORDINATOR', 'VIP_DELIVERY_RECOVER'), ('COORDINATOR', 'PLAYER_ACCOUNT_MODERATE'),
        ('COORDINATOR', 'PLAYER_ECONOMY_ADJUST'), ('COORDINATOR', 'PLAYER_CHAT_MODERATE'),
        ('GENERAL_CHIEF', 'OPERATIONS_READ'), ('GENERAL_CHIEF', 'PLAYER_TRADE_RECOVER'),
        ('GENERAL_CHIEF', 'PLAYER_MARKETPLACE_RECOVER'), ('GENERAL_CHIEF', 'VIP_DELIVERY_RECOVER'),
        ('GENERAL_CHIEF', 'PLAYER_ACCOUNT_MODERATE'), ('GENERAL_CHIEF', 'PLAYER_CHAT_MODERATE'),
        ('ADMIN', 'PLAYER_ACCOUNT_MODERATE'), ('ADMIN', 'PLAYER_CHAT_MODERATE'),
        ('MODERATOR', 'PLAYER_CHAT_MODERATE'),
        ('DEV', 'OPERATIONS_READ'), ('DEV', 'SERVER_CONTROL_RESOLVE'),
        ('DEV', 'PLAYER_TRADE_RECOVER'), ('DEV', 'PLAYER_MARKETPLACE_RECOVER');

      CREATE TABLE operator_actions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        staff_id uuid NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        request_fingerprint char(64) NOT NULL,
        domain varchar(32) NOT NULL,
        action varchar(32) NOT NULL,
        resource_id varchar(128) NOT NULL,
        reason varchar(500) NOT NULL,
        outcome varchar(32) NOT NULL,
        result jsonb NOT NULL,
        request_id varchar(128),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT operator_actions_staff_fkey FOREIGN KEY (staff_id) REFERENCES staff_users(id),
        CONSTRAINT operator_actions_idempotency_key UNIQUE (staff_id, idempotency_key),
        CONSTRAINT operator_actions_domain_check CHECK (domain IN ('SERVER_CONTROL', 'PLAYER_TRADE', 'MARKETPLACE_CUSTODY', 'MARKETPLACE_SETTLEMENT', 'MARKETPLACE_RELEASE', 'VIP_DELIVERY', 'PLAYER_ACCOUNT', 'PLAYER_ECONOMY', 'PLAYER_CHAT')),
        CONSTRAINT operator_actions_action_check CHECK (action IN ('RETRY_SAFE', 'REQUEUE_SAME_WORK', 'ACKNOWLEDGE', 'RESOLVE_SUCCEEDED', 'RESOLVE_FAILED', 'CANCEL', 'SET_STATUS', 'ADJUST', 'HIDE')),
        CONSTRAINT operator_actions_content_check CHECK (length(btrim(reason)) > 0 AND length(idempotency_key) > 0 AND request_fingerprint ~ '^[0-9a-f]{64}$' AND jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096)
      );
      CREATE INDEX operator_actions_resource_idx ON operator_actions(domain, resource_id, created_at);

      ALTER TABLE server_control_operations
        ADD COLUMN resolution varchar(24),
        ADD COLUMN resolved_by_staff_id uuid,
        ADD COLUMN resolved_at timestamptz,
        ADD COLUMN resolution_reason varchar(500),
        ADD CONSTRAINT server_control_operations_resolver_fkey FOREIGN KEY (resolved_by_staff_id) REFERENCES staff_users(id),
        ADD CONSTRAINT server_control_operations_resolution_check CHECK ((resolution IS NULL AND resolved_by_staff_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL) OR (status = 'UNCERTAIN' AND resolution IN ('RESOLVED_SUCCEEDED', 'RESOLVED_FAILED') AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL));

      ALTER TABLE vip_reward_deliveries
        ADD COLUMN attempt smallint NOT NULL DEFAULT 1,
        ADD COLUMN resolution varchar(32),
        ADD COLUMN resolved_by_staff_id uuid,
        ADD COLUMN resolved_at timestamptz,
        ADD COLUMN resolution_reason varchar(500),
        ADD CONSTRAINT vip_reward_deliveries_resolver_fkey FOREIGN KEY (resolved_by_staff_id) REFERENCES staff_users(id),
        ADD CONSTRAINT vip_reward_deliveries_attempt_check CHECK (attempt BETWEEN 1 AND 10),
        ADD CONSTRAINT vip_reward_deliveries_resolution_check CHECK ((resolution IS NULL AND resolved_by_staff_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL) OR (status IN ('FAILED', 'UNCERTAIN') AND resolution IN ('CONFIRMED_DELIVERED', 'CONFIRMED_NOT_DELIVERED') AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL));
      CREATE TABLE vip_reward_delivery_attempts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        delivery_id uuid NOT NULL,
        attempt smallint NOT NULL,
        game_command_id uuid,
        status varchar(16) NOT NULL,
        error_code varchar(64) NOT NULL,
        completed_at timestamptz NOT NULL,
        resolution varchar(32),
        resolved_by_staff_id uuid,
        resolved_at timestamptz,
        resolution_reason varchar(500),
        retried_by_staff_id uuid NOT NULL,
        retry_reason varchar(500) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vip_reward_delivery_attempts_delivery_fkey FOREIGN KEY (delivery_id) REFERENCES vip_reward_deliveries(id),
        CONSTRAINT vip_reward_delivery_attempts_command_fkey FOREIGN KEY (game_command_id) REFERENCES game_commands(id),
        CONSTRAINT vip_reward_delivery_attempts_resolver_fkey FOREIGN KEY (resolved_by_staff_id) REFERENCES staff_users(id),
        CONSTRAINT vip_reward_delivery_attempts_retrier_fkey FOREIGN KEY (retried_by_staff_id) REFERENCES staff_users(id),
        CONSTRAINT vip_reward_delivery_attempts_attempt_key UNIQUE (delivery_id, attempt),
        CONSTRAINT vip_reward_delivery_attempts_command_key UNIQUE (game_command_id),
        CONSTRAINT vip_reward_delivery_attempts_status_check CHECK (status IN ('FAILED', 'UNCERTAIN') AND attempt BETWEEN 1 AND 10 AND length(btrim(retry_reason)) > 0),
        CONSTRAINT vip_reward_delivery_attempts_resolution_check CHECK ((resolution IS NULL AND resolved_by_staff_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL) OR (resolution = 'CONFIRMED_NOT_DELIVERED' AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL))
      );

      ALTER TABLE player_marketplace_item_releases
        ADD COLUMN resolution varchar(24),
        ADD COLUMN resolved_by_staff_id uuid,
        ADD COLUMN resolved_at timestamptz,
        ADD COLUMN resolution_reason varchar(500),
        ADD CONSTRAINT player_marketplace_item_releases_resolver_fkey FOREIGN KEY (resolved_by_staff_id) REFERENCES staff_users(id),
        ADD CONSTRAINT player_marketplace_item_releases_resolution_check CHECK ((resolution IS NULL AND resolved_by_staff_id IS NULL AND resolved_at IS NULL AND resolution_reason IS NULL) OR (status = 'FAILED' AND resolution IN ('RESOLVED_SUCCEEDED', 'RESOLVED_FAILED') AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL));

      ALTER TABLE economy_accounts
        DROP CONSTRAINT economy_accounts_owner_check,
        ADD CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN', 'TRADE_ESCROW', 'MARKET_ESCROW', 'ADJUSTMENT')));
      ALTER TABLE economy_transactions
        DROP CONSTRAINT economy_transactions_type_check,
        ADD CONSTRAINT economy_transactions_type_check CHECK (type IN ('SYSTEM_CREDIT', 'SYSTEM_DEBIT', 'TRANSFER', 'STAFF_ADJUSTMENT') AND (type = 'TRANSFER' OR (type IN ('SYSTEM_CREDIT', 'SYSTEM_DEBIT') AND actor_type = 'SYSTEM') OR (type = 'STAFF_ADJUSTMENT' AND actor_type = 'STAFF')));

      ALTER TABLE player_chat_messages
        ADD COLUMN moderated_at timestamptz,
        ADD COLUMN moderated_by_staff_id uuid,
        ADD COLUMN moderation_reason varchar(500),
        ADD CONSTRAINT player_chat_messages_moderator_fkey FOREIGN KEY (moderated_by_staff_id) REFERENCES staff_users(id),
        ADD CONSTRAINT player_chat_messages_moderation_check CHECK ((moderated_at IS NULL AND moderated_by_staff_id IS NULL AND moderation_reason IS NULL) OR (moderated_at IS NOT NULL AND moderated_by_staff_id IS NOT NULL AND moderation_reason IS NOT NULL));
      -- Messages stay append-only except for the single hide by a moderator:
      -- only the moderation columns may change, once, from empty.
      CREATE FUNCTION guard_player_chat_message_history() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        moderation text[] := ARRAY['moderated_at', 'moderated_by_staff_id', 'moderation_reason'];
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF OLD.moderated_at IS NULL AND NEW.moderated_at IS NOT NULL
             AND (to_jsonb(NEW) - moderation) = (to_jsonb(OLD) - moderation) THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
        END IF;
        IF OLD.expires_at > now() THEN
          RAISE EXCEPTION '% rows can only be purged after expiry', TG_TABLE_NAME USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END;
      $$;
      DROP TRIGGER player_chat_messages_guard ON player_chat_messages;
      CREATE TRIGGER player_chat_messages_guard
        BEFORE UPDATE OR DELETE ON player_chat_messages
        FOR EACH ROW EXECUTE FUNCTION guard_player_chat_message_history();

      CREATE TABLE agent_work_rejections (
        kind varchar(48) NOT NULL,
        work_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        reason varchar(64) NOT NULL,
        rejection_count integer NOT NULL DEFAULT 1,
        first_rejected_at timestamptz NOT NULL DEFAULT now(),
        last_rejected_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT agent_work_rejections_pkey PRIMARY KEY (kind, work_id),
        CONSTRAINT agent_work_rejections_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT agent_work_rejections_kind_check CHECK (kind IN ('TRADE_SETTLEMENT', 'MARKETPLACE_CUSTODY', 'MARKETPLACE_SETTLEMENT', 'MARKETPLACE_RELEASE') AND rejection_count >= 1 AND length(btrim(reason)) > 0)
      );
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Operator evidence is never silently discarded.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM economy_transactions WHERE type = 'STAFF_ADJUSTMENT')
          OR EXISTS (SELECT 1 FROM economy_accounts WHERE system_key = 'ADJUSTMENT')
          OR EXISTS (SELECT 1 FROM vip_reward_deliveries WHERE attempt > 1 OR resolution IS NOT NULL)
          OR EXISTS (SELECT 1 FROM server_control_operations WHERE resolution IS NOT NULL)
          OR EXISTS (SELECT 1 FROM player_marketplace_item_releases WHERE resolution IS NOT NULL)
          OR EXISTS (SELECT 1 FROM player_chat_messages WHERE moderated_at IS NOT NULL) THEN
          RAISE EXCEPTION 'operational recovery records exist; this migration is forward-only' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE agent_work_rejections;
      DROP TRIGGER player_chat_messages_guard ON player_chat_messages;
      CREATE TRIGGER player_chat_messages_guard
        BEFORE UPDATE OR DELETE ON player_chat_messages
        FOR EACH ROW EXECUTE FUNCTION guard_player_chat_history();
      DROP FUNCTION guard_player_chat_message_history();
      ALTER TABLE player_chat_messages
        DROP CONSTRAINT player_chat_messages_moderation_check,
        DROP CONSTRAINT player_chat_messages_moderator_fkey,
        DROP COLUMN moderation_reason,
        DROP COLUMN moderated_by_staff_id,
        DROP COLUMN moderated_at;
      ALTER TABLE economy_transactions
        DROP CONSTRAINT economy_transactions_type_check,
        ADD CONSTRAINT economy_transactions_type_check CHECK (type IN ('SYSTEM_CREDIT', 'SYSTEM_DEBIT', 'TRANSFER') AND (type = 'TRANSFER' OR actor_type = 'SYSTEM'));
      ALTER TABLE economy_accounts
        DROP CONSTRAINT economy_accounts_owner_check,
        ADD CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN', 'TRADE_ESCROW', 'MARKET_ESCROW')));
      ALTER TABLE player_marketplace_item_releases
        DROP CONSTRAINT player_marketplace_item_releases_resolution_check,
        DROP CONSTRAINT player_marketplace_item_releases_resolver_fkey,
        DROP COLUMN resolution_reason,
        DROP COLUMN resolved_at,
        DROP COLUMN resolved_by_staff_id,
        DROP COLUMN resolution;
      DROP TABLE vip_reward_delivery_attempts;
      ALTER TABLE vip_reward_deliveries
        DROP CONSTRAINT vip_reward_deliveries_resolution_check,
        DROP CONSTRAINT vip_reward_deliveries_attempt_check,
        DROP CONSTRAINT vip_reward_deliveries_resolver_fkey,
        DROP COLUMN resolution_reason,
        DROP COLUMN resolved_at,
        DROP COLUMN resolved_by_staff_id,
        DROP COLUMN resolution,
        DROP COLUMN attempt;
      ALTER TABLE server_control_operations
        DROP CONSTRAINT server_control_operations_resolution_check,
        DROP CONSTRAINT server_control_operations_resolver_fkey,
        DROP COLUMN resolution_reason,
        DROP COLUMN resolved_at,
        DROP COLUMN resolved_by_staff_id,
        DROP COLUMN resolution;
      DROP TABLE operator_actions;
      DELETE FROM role_permissions WHERE permission_name IN ('OPERATIONS_READ', 'SERVER_CONTROL_RESOLVE', 'PLAYER_TRADE_RECOVER', 'PLAYER_MARKETPLACE_RECOVER', 'VIP_DELIVERY_RECOVER', 'PLAYER_ACCOUNT_MODERATE', 'PLAYER_ECONOMY_ADJUST', 'PLAYER_CHAT_MODERATE');
      DELETE FROM permissions WHERE name IN ('OPERATIONS_READ', 'SERVER_CONTROL_RESOLVE', 'PLAYER_TRADE_RECOVER', 'PLAYER_MARKETPLACE_RECOVER', 'VIP_DELIVERY_RECOVER', 'PLAYER_ACCOUNT_MODERATE', 'PLAYER_ECONOMY_ADJUST', 'PLAYER_CHAT_MODERATE');
    `);
  }
}
