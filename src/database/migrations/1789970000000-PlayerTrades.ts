import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerTrades1789970000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // TRADE_ESCROW joins the closed system keys (the 10.12 migration stays).
    await queryRunner.query(`
      ALTER TABLE economy_accounts
        DROP CONSTRAINT economy_accounts_owner_check,
        ADD CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN', 'TRADE_ESCROW')));

      CREATE TABLE player_trades (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        initiator_character_id varchar(128) NOT NULL,
        target_character_id varchar(128) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'NEGOTIATING',
        initiator_accepted_at timestamptz,
        target_accepted_at timestamptz,
        locked_at timestamptz,
        completed_at timestamptz,
        cancelled_at timestamptz,
        failed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_trades_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_trades_parties_check CHECK (initiator_character_id <> target_character_id AND length(btrim(initiator_character_id)) > 0 AND length(btrim(target_character_id)) > 0),
        CONSTRAINT player_trades_status_check CHECK (status IN ('NEGOTIATING', 'AWAITING_GAME_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'FAILED')),
        CONSTRAINT player_trades_lifecycle_check CHECK (
          (status = 'NEGOTIATING' AND locked_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'AWAITING_GAME_CONFIRMATION' AND initiator_accepted_at IS NOT NULL AND target_accepted_at IS NOT NULL AND locked_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'COMPLETED' AND initiator_accepted_at IS NOT NULL AND target_accepted_at IS NOT NULL AND locked_at IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'CANCELLED' AND locked_at IS NULL AND cancelled_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL)
          OR (status = 'FAILED' AND locked_at IS NOT NULL AND failed_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL))
      );
      CREATE INDEX player_trades_initiator_idx ON player_trades(game_server_id, initiator_character_id, created_at);
      CREATE INDEX player_trades_target_idx ON player_trades(game_server_id, target_character_id, created_at);
      CREATE TABLE player_trade_offers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trade_id uuid NOT NULL,
        side varchar(16) NOT NULL,
        gold_amount bigint NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_trade_offers_trade_fkey FOREIGN KEY (trade_id) REFERENCES player_trades(id),
        CONSTRAINT player_trade_offers_side_key UNIQUE (trade_id, side),
        CONSTRAINT player_trade_offers_side_check CHECK (side IN ('INITIATOR', 'TARGET')),
        CONSTRAINT player_trade_offers_gold_check CHECK (gold_amount BETWEEN 0 AND 1000000000000),
        CONSTRAINT player_trade_offers_version_check CHECK (version >= 1)
      );
      CREATE TABLE player_trade_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        offer_id uuid NOT NULL,
        item_external_id varchar(128) NOT NULL,
        quantity integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_trade_items_offer_fkey FOREIGN KEY (offer_id) REFERENCES player_trade_offers(id),
        CONSTRAINT player_trade_items_item_key UNIQUE (offer_id, item_external_id),
        CONSTRAINT player_trade_items_item_check CHECK (length(btrim(item_external_id)) > 0),
        CONSTRAINT player_trade_items_quantity_check CHECK (quantity BETWEEN 1 AND 10000)
      );
      CREATE TABLE player_trade_currency_escrows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trade_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        currency varchar(16) NOT NULL,
        character_external_id varchar(128) NOT NULL,
        amount bigint NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'RESERVED',
        reservation_transaction_id uuid NOT NULL,
        resolution_transaction_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_trade_currency_escrows_trade_fkey FOREIGN KEY (trade_id) REFERENCES player_trades(id),
        CONSTRAINT player_trade_currency_escrows_reservation_fkey FOREIGN KEY (reservation_transaction_id) REFERENCES economy_transactions(id),
        CONSTRAINT player_trade_currency_escrows_resolution_fkey FOREIGN KEY (resolution_transaction_id) REFERENCES economy_transactions(id),
        CONSTRAINT player_trade_currency_escrows_party_key UNIQUE (trade_id, character_external_id),
        CONSTRAINT player_trade_currency_escrows_currency_check CHECK (currency IN ('GOLD')),
        CONSTRAINT player_trade_currency_escrows_amount_check CHECK (amount BETWEEN 1 AND 1000000000000),
        CONSTRAINT player_trade_currency_escrows_status_check CHECK (status IN ('RESERVED', 'RELEASED', 'SETTLED')),
        CONSTRAINT player_trade_currency_escrows_resolution_check CHECK ((status = 'RESERVED') = (resolution_transaction_id IS NULL))
      );
      CREATE INDEX player_trade_currency_escrows_status_idx ON player_trade_currency_escrows(game_server_id, currency, status);
      CREATE TABLE player_trade_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_scope varchar(64) NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        player_id uuid NOT NULL,
        operation varchar(16) NOT NULL,
        request_fingerprint char(64) NOT NULL,
        trade_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_trade_requests_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_trade_requests_trade_fkey FOREIGN KEY (trade_id) REFERENCES player_trades(id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT player_trade_requests_idempotency_key UNIQUE (idempotency_scope, idempotency_key),
        CONSTRAINT player_trade_requests_scope_check CHECK (idempotency_scope = ('PLAYER:' || player_id::text) AND length(idempotency_key) > 0),
        CONSTRAINT player_trade_requests_operation_check CHECK (operation IN ('CREATE', 'OFFER', 'ACCEPT', 'CANCEL'))
      );
      CREATE TABLE player_trade_settlement_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        settlement_event_id varchar(128) NOT NULL,
        trade_id uuid NOT NULL,
        outcome varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_trade_settlement_events_trade_fkey FOREIGN KEY (trade_id) REFERENCES player_trades(id),
        CONSTRAINT player_trade_settlement_events_event_key UNIQUE (game_server_id, settlement_event_id),
        CONSTRAINT player_trade_settlement_events_trade_key UNIQUE (trade_id),
        CONSTRAINT player_trade_settlement_events_outcome_check CHECK (outcome IN ('SETTLED', 'FAILED') AND length(btrim(settlement_event_id)) > 0)
      );

      -- Terminal trades never reopen; only forward transitions are allowed.
      CREATE FUNCTION guard_player_trade() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'player trades are kept as history' USING ERRCODE = '55000';
        END IF;
        IF (NEW.id, NEW.game_server_id, NEW.initiator_character_id, NEW.target_character_id, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.game_server_id, OLD.initiator_character_id, OLD.target_character_id, OLD.created_at)
          OR NOT (
            (OLD.status = 'NEGOTIATING' AND NEW.status IN ('NEGOTIATING', 'AWAITING_GAME_CONFIRMATION', 'COMPLETED', 'CANCELLED'))
            OR (OLD.status = 'AWAITING_GAME_CONFIRMATION' AND NEW.status IN ('COMPLETED', 'FAILED'))) THEN
          RAISE EXCEPTION 'invalid player trade transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_trades_guard
        BEFORE UPDATE OR DELETE ON player_trades
        FOR EACH ROW EXECUTE FUNCTION guard_player_trade();
      -- Offers and their items change only while the trade is NEGOTIATING.
      CREATE FUNCTION guard_player_trade_offer() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        trade uuid;
        current varchar;
      BEGIN
        IF TG_TABLE_NAME = 'player_trade_offers' THEN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'player trade offers are kept' USING ERRCODE = '55000';
          END IF;
          trade := NEW.trade_id;
        ELSIF TG_OP = 'DELETE' THEN
          SELECT trade_id INTO trade FROM player_trade_offers WHERE id = OLD.offer_id;
        ELSE
          SELECT trade_id INTO trade FROM player_trade_offers WHERE id = NEW.offer_id;
        END IF;
        SELECT status INTO current FROM player_trades WHERE id = trade;
        IF current IS DISTINCT FROM 'NEGOTIATING' THEN
          RAISE EXCEPTION 'player trade offers are locked' USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_trade_offers_guard
        BEFORE INSERT OR UPDATE OR DELETE ON player_trade_offers
        FOR EACH ROW EXECUTE FUNCTION guard_player_trade_offer();
      CREATE TRIGGER player_trade_items_guard
        BEFORE INSERT OR UPDATE OR DELETE ON player_trade_items
        FOR EACH ROW EXECUTE FUNCTION guard_player_trade_offer();
      -- Escrows only move RESERVED -> RELEASED/SETTLED, once, and stay.
      CREATE FUNCTION guard_player_trade_escrow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'RESERVED'
          OR (NEW.id, NEW.trade_id, NEW.game_server_id, NEW.currency, NEW.character_external_id, NEW.amount, NEW.reservation_transaction_id, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.trade_id, OLD.game_server_id, OLD.currency, OLD.character_external_id, OLD.amount, OLD.reservation_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'player trade escrows are append-only once resolved' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_trade_currency_escrows_guard
        BEFORE UPDATE OR DELETE ON player_trade_currency_escrows
        FOR EACH ROW EXECUTE FUNCTION guard_player_trade_escrow();
      CREATE FUNCTION reject_player_trade_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER player_trade_requests_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON player_trade_requests
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_trade_history_mutation();
      CREATE TRIGGER player_trade_settlement_events_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON player_trade_settlement_events
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_trade_history_mutation();
      CREATE TRIGGER player_trades_truncate
        BEFORE TRUNCATE ON player_trades
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_trade_history_mutation();
      CREATE TRIGGER player_trade_currency_escrows_truncate
        BEFORE TRUNCATE ON player_trade_currency_escrows
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_trade_history_mutation();
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to erase trades or escrow bookkeeping backed by the ledger.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM player_trades) OR EXISTS (SELECT 1 FROM economy_accounts WHERE system_key = 'TRADE_ESCROW') THEN
          RAISE EXCEPTION 'player trades exist; refusing to drop them' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE player_trade_settlement_events;
      DROP TABLE player_trade_requests;
      DROP TABLE player_trade_currency_escrows;
      DROP TABLE player_trade_items;
      DROP TABLE player_trade_offers;
      DROP TABLE player_trades;
      DROP FUNCTION reject_player_trade_history_mutation();
      DROP FUNCTION guard_player_trade_escrow();
      DROP FUNCTION guard_player_trade_offer();
      DROP FUNCTION guard_player_trade();
      ALTER TABLE economy_accounts
        DROP CONSTRAINT economy_accounts_owner_check,
        ADD CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN')));
    `);
  }
}
