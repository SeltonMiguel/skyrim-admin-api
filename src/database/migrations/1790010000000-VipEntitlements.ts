import type { MigrationInterface, QueryRunner } from 'typeorm';
export class VipEntitlements1790010000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Explicit scope on the Stage 08 catalog (its migration stays). Existing
    // offers get CHARACTER: all reward types are character gameplay benefits.
    await queryRunner.query(`
      ALTER TABLE vip_offers
        ADD COLUMN entitlement_scope varchar(16) NOT NULL DEFAULT 'CHARACTER',
        ADD CONSTRAINT vip_offers_entitlement_scope_check CHECK (entitlement_scope IN ('PLAYER', 'CHARACTER'));

      CREATE TABLE player_vip_entitlements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        vip_offer_id uuid NOT NULL,
        scope varchar(16) NOT NULL,
        player_id uuid,
        game_server_id uuid,
        character_external_id varchar(128),
        status varchar(16) NOT NULL DEFAULT 'ACTIVE',
        granted_at timestamptz NOT NULL,
        expires_at timestamptz,
        revoked_at timestamptz,
        source varchar(64) NOT NULL,
        external_reference varchar(128),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_vip_entitlements_offer_fkey FOREIGN KEY (vip_offer_id) REFERENCES vip_offers(id),
        CONSTRAINT player_vip_entitlements_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_vip_entitlements_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_vip_entitlements_scope_check CHECK (
          (scope = 'PLAYER' AND player_id IS NOT NULL AND game_server_id IS NULL AND character_external_id IS NULL)
          OR (scope = 'CHARACTER' AND player_id IS NULL AND game_server_id IS NOT NULL AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0)),
        CONSTRAINT player_vip_entitlements_status_check CHECK (
          (status = 'ACTIVE' AND revoked_at IS NULL)
          OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
          OR (status = 'EXPIRED' AND expires_at IS NOT NULL AND revoked_at IS NULL)),
        CONSTRAINT player_vip_entitlements_expiry_check CHECK (expires_at IS NULL OR expires_at > granted_at),
        CONSTRAINT player_vip_entitlements_source_check CHECK (source ~ '^(STAFF|SYSTEM:[A-Z_]{1,32})$' AND (external_reference IS NULL OR length(btrim(external_reference)) > 0))
      );
      CREATE UNIQUE INDEX player_vip_entitlements_player_active_key ON player_vip_entitlements(vip_offer_id, player_id) WHERE status = 'ACTIVE' AND scope = 'PLAYER';
      CREATE UNIQUE INDEX player_vip_entitlements_character_active_key ON player_vip_entitlements(vip_offer_id, game_server_id, character_external_id) WHERE status = 'ACTIVE' AND scope = 'CHARACTER';
      CREATE INDEX player_vip_entitlements_player_idx ON player_vip_entitlements(player_id, status);
      CREATE INDEX player_vip_entitlements_character_idx ON player_vip_entitlements(game_server_id, character_external_id, status);
      CREATE TABLE vip_entitlement_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_scope varchar(64) NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        operation varchar(16) NOT NULL,
        request_fingerprint char(64) NOT NULL,
        entitlement_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vip_entitlement_requests_entitlement_fkey FOREIGN KEY (entitlement_id) REFERENCES player_vip_entitlements(id),
        CONSTRAINT vip_entitlement_requests_idempotency_key UNIQUE (idempotency_scope, idempotency_key),
        CONSTRAINT vip_entitlement_requests_scope_check CHECK (idempotency_scope ~ '^(STAFF|SYSTEM:[A-Z_]{1,32})$' AND length(idempotency_key) > 0),
        CONSTRAINT vip_entitlement_requests_operation_check CHECK (operation IN ('GRANT', 'REVOKE'))
      );

      -- The holder, offer and grant never change; only ACTIVE -> REVOKED or
      -- EXPIRED, once. Rows are kept as history.
      CREATE FUNCTION guard_player_vip_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'VIP entitlements are kept as history' USING ERRCODE = '55000';
        END IF;
        IF (NEW.id, NEW.vip_offer_id, NEW.scope, NEW.player_id, NEW.game_server_id, NEW.character_external_id, NEW.granted_at, NEW.expires_at, NEW.source, NEW.external_reference, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.vip_offer_id, OLD.scope, OLD.player_id, OLD.game_server_id, OLD.character_external_id, OLD.granted_at, OLD.expires_at, OLD.source, OLD.external_reference, OLD.created_at)
          OR NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('REVOKED', 'EXPIRED')) THEN
          RAISE EXCEPTION 'invalid VIP entitlement change % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_vip_entitlements_guard
        BEFORE UPDATE OR DELETE ON player_vip_entitlements
        FOR EACH ROW EXECUTE FUNCTION guard_player_vip_entitlement();
      CREATE FUNCTION reject_vip_entitlement_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER vip_entitlement_requests_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON vip_entitlement_requests
        FOR EACH STATEMENT EXECUTE FUNCTION reject_vip_entitlement_history_mutation();
      CREATE TRIGGER player_vip_entitlements_truncate
        BEFORE TRUNCATE ON player_vip_entitlements
        FOR EACH STATEMENT EXECUTE FUNCTION reject_vip_entitlement_history_mutation();
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to erase granted rights.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM player_vip_entitlements) THEN
          RAISE EXCEPTION 'VIP entitlements exist; refusing to drop them' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE vip_entitlement_requests;
      DROP TABLE player_vip_entitlements;
      DROP FUNCTION reject_vip_entitlement_history_mutation();
      DROP FUNCTION guard_player_vip_entitlement();
      ALTER TABLE vip_offers
        DROP CONSTRAINT vip_offers_entitlement_scope_check,
        DROP COLUMN entitlement_scope;
    `);
  }
}
