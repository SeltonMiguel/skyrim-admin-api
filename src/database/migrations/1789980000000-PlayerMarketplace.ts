import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerMarketplace1789980000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // MARKET_ESCROW joins the closed system keys (10.12/10.13 migrations stay).
    await queryRunner.query(`
      ALTER TABLE economy_accounts
        DROP CONSTRAINT economy_accounts_owner_check,
        ADD CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN', 'TRADE_ESCROW', 'MARKET_ESCROW')));

      CREATE TABLE player_marketplace_listings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        seller_character_id varchar(128) NOT NULL,
        item_external_id varchar(128) NOT NULL,
        quantity integer NOT NULL,
        price_gold bigint NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'PENDING_CUSTODY',
        custody_event_id varchar(128),
        reserved_by_character_id varchar(128),
        reserved_at timestamptz,
        sold_at timestamptz,
        cancelled_at timestamptz,
        failed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_marketplace_listings_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_marketplace_listings_terms_check CHECK (length(btrim(seller_character_id)) > 0 AND length(btrim(item_external_id)) > 0 AND quantity BETWEEN 1 AND 10000 AND price_gold BETWEEN 1 AND 1000000000000),
        CONSTRAINT player_marketplace_listings_status_check CHECK (status IN ('PENDING_CUSTODY', 'ACTIVE', 'RESERVED', 'SOLD', 'CANCELLED', 'FAILED')),
        CONSTRAINT player_marketplace_listings_buyer_check CHECK (reserved_by_character_id IS DISTINCT FROM seller_character_id AND (reserved_by_character_id IS NULL) = (reserved_at IS NULL)),
        CONSTRAINT player_marketplace_listings_lifecycle_check CHECK (
          (status = 'PENDING_CUSTODY' AND custody_event_id IS NULL AND reserved_at IS NULL AND sold_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'ACTIVE' AND custody_event_id IS NOT NULL AND reserved_at IS NULL AND sold_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'RESERVED' AND custody_event_id IS NOT NULL AND reserved_at IS NOT NULL AND sold_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'SOLD' AND custody_event_id IS NOT NULL AND reserved_at IS NOT NULL AND sold_at IS NOT NULL AND cancelled_at IS NULL AND failed_at IS NULL)
          OR (status = 'CANCELLED' AND reserved_at IS NULL AND cancelled_at IS NOT NULL AND sold_at IS NULL AND failed_at IS NULL)
          OR (status = 'FAILED' AND custody_event_id IS NOT NULL AND failed_at IS NOT NULL AND sold_at IS NULL AND cancelled_at IS NULL))
      );
      CREATE INDEX player_marketplace_listings_browse_idx ON player_marketplace_listings(status, created_at, id);
      CREATE INDEX player_marketplace_listings_seller_idx ON player_marketplace_listings(game_server_id, seller_character_id, created_at);
      CREATE UNIQUE INDEX player_marketplace_listings_custody_key ON player_marketplace_listings(game_server_id, custody_event_id) WHERE custody_event_id IS NOT NULL;
      CREATE TABLE player_marketplace_purchases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id uuid NOT NULL,
        buyer_character_id varchar(128) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'AWAITING_GAME_CONFIRMATION',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        failed_at timestamptz,
        CONSTRAINT player_marketplace_purchases_listing_fkey FOREIGN KEY (listing_id) REFERENCES player_marketplace_listings(id),
        CONSTRAINT player_marketplace_purchases_listing_key UNIQUE (listing_id),
        CONSTRAINT player_marketplace_purchases_buyer_check CHECK (length(btrim(buyer_character_id)) > 0),
        CONSTRAINT player_marketplace_purchases_status_check CHECK (status IN ('AWAITING_GAME_CONFIRMATION', 'COMPLETED', 'FAILED')),
        CONSTRAINT player_marketplace_purchases_lifecycle_check CHECK (
          (status = 'AWAITING_GAME_CONFIRMATION' AND completed_at IS NULL AND failed_at IS NULL)
          OR (status = 'COMPLETED' AND completed_at IS NOT NULL AND failed_at IS NULL)
          OR (status = 'FAILED' AND failed_at IS NOT NULL AND completed_at IS NULL))
      );
      CREATE INDEX player_marketplace_purchases_buyer_idx ON player_marketplace_purchases(buyer_character_id, created_at);
      CREATE TABLE player_marketplace_currency_escrows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        purchase_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        currency varchar(16) NOT NULL,
        buyer_character_id varchar(128) NOT NULL,
        seller_character_id varchar(128) NOT NULL,
        amount bigint NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'RESERVED',
        reservation_transaction_id uuid NOT NULL,
        resolution_transaction_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_marketplace_currency_escrows_purchase_fkey FOREIGN KEY (purchase_id) REFERENCES player_marketplace_purchases(id),
        CONSTRAINT player_marketplace_currency_escrows_reservation_fkey FOREIGN KEY (reservation_transaction_id) REFERENCES economy_transactions(id),
        CONSTRAINT player_marketplace_currency_escrows_resolution_fkey FOREIGN KEY (resolution_transaction_id) REFERENCES economy_transactions(id),
        CONSTRAINT player_marketplace_currency_escrows_purchase_key UNIQUE (purchase_id),
        CONSTRAINT player_marketplace_currency_escrows_currency_check CHECK (currency IN ('GOLD')),
        CONSTRAINT player_marketplace_currency_escrows_parties_check CHECK (buyer_character_id <> seller_character_id AND amount BETWEEN 1 AND 1000000000000),
        CONSTRAINT player_marketplace_currency_escrows_status_check CHECK (status IN ('RESERVED', 'RELEASED', 'SETTLED')),
        CONSTRAINT player_marketplace_currency_escrows_resolution_check CHECK ((status = 'RESERVED') = (resolution_transaction_id IS NULL))
      );
      CREATE INDEX player_marketplace_currency_escrows_status_idx ON player_marketplace_currency_escrows(game_server_id, currency, status);
      CREATE TABLE player_marketplace_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_scope varchar(64) NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        player_id uuid NOT NULL,
        operation varchar(16) NOT NULL,
        request_fingerprint char(64) NOT NULL,
        listing_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_marketplace_requests_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_marketplace_requests_listing_fkey FOREIGN KEY (listing_id) REFERENCES player_marketplace_listings(id) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT player_marketplace_requests_idempotency_key UNIQUE (idempotency_scope, idempotency_key),
        CONSTRAINT player_marketplace_requests_scope_check CHECK (idempotency_scope = ('PLAYER:' || player_id::text) AND length(idempotency_key) > 0),
        CONSTRAINT player_marketplace_requests_operation_check CHECK (operation IN ('CREATE', 'CANCEL', 'PURCHASE'))
      );
      CREATE TABLE player_marketplace_custody_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        custody_event_id varchar(128) NOT NULL,
        listing_id uuid NOT NULL,
        outcome varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_marketplace_custody_events_listing_fkey FOREIGN KEY (listing_id) REFERENCES player_marketplace_listings(id),
        CONSTRAINT player_marketplace_custody_events_event_key UNIQUE (game_server_id, custody_event_id),
        CONSTRAINT player_marketplace_custody_events_listing_key UNIQUE (listing_id),
        CONSTRAINT player_marketplace_custody_events_outcome_check CHECK (outcome IN ('CUSTODIED', 'FAILED') AND length(btrim(custody_event_id)) > 0)
      );
      CREATE TABLE player_marketplace_settlement_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        settlement_event_id varchar(128) NOT NULL,
        purchase_id uuid NOT NULL,
        outcome varchar(16) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_marketplace_settlement_events_purchase_fkey FOREIGN KEY (purchase_id) REFERENCES player_marketplace_purchases(id),
        CONSTRAINT player_marketplace_settlement_events_event_key UNIQUE (game_server_id, settlement_event_id),
        CONSTRAINT player_marketplace_settlement_events_purchase_key UNIQUE (purchase_id),
        CONSTRAINT player_marketplace_settlement_events_outcome_check CHECK (outcome IN ('SETTLED', 'FAILED') AND length(btrim(settlement_event_id)) > 0)
      );

      -- Listing terms never change; custody and the buyer are set once;
      -- only forward transitions; terminal listings never reopen.
      CREATE FUNCTION guard_player_marketplace_listing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'marketplace listings are kept as history' USING ERRCODE = '55000';
        END IF;
        IF (NEW.id, NEW.game_server_id, NEW.seller_character_id, NEW.item_external_id, NEW.quantity, NEW.price_gold, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.game_server_id, OLD.seller_character_id, OLD.item_external_id, OLD.quantity, OLD.price_gold, OLD.created_at)
          OR (OLD.custody_event_id IS NOT NULL AND NEW.custody_event_id IS DISTINCT FROM OLD.custody_event_id)
          OR (OLD.reserved_by_character_id IS NOT NULL AND (NEW.reserved_by_character_id, NEW.reserved_at) IS DISTINCT FROM (OLD.reserved_by_character_id, OLD.reserved_at))
          OR NOT (
            (OLD.status = 'PENDING_CUSTODY' AND NEW.status IN ('ACTIVE', 'CANCELLED', 'FAILED'))
            OR (OLD.status = 'ACTIVE' AND NEW.status IN ('RESERVED', 'CANCELLED'))
            OR (OLD.status = 'RESERVED' AND NEW.status IN ('SOLD', 'FAILED'))) THEN
          RAISE EXCEPTION 'invalid marketplace listing transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_marketplace_listings_guard
        BEFORE UPDATE OR DELETE ON player_marketplace_listings
        FOR EACH ROW EXECUTE FUNCTION guard_player_marketplace_listing();
      CREATE FUNCTION guard_player_marketplace_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE'
          OR (NEW.id, NEW.listing_id, NEW.buyer_character_id, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.listing_id, OLD.buyer_character_id, OLD.created_at)
          OR NOT (OLD.status = 'AWAITING_GAME_CONFIRMATION' AND NEW.status IN ('COMPLETED', 'FAILED')) THEN
          RAISE EXCEPTION 'invalid marketplace purchase change' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_marketplace_purchases_guard
        BEFORE UPDATE OR DELETE ON player_marketplace_purchases
        FOR EACH ROW EXECUTE FUNCTION guard_player_marketplace_purchase();
      -- Escrows only move RESERVED -> RELEASED/SETTLED, once, and stay.
      CREATE FUNCTION guard_player_marketplace_escrow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' OR OLD.status <> 'RESERVED'
          OR (NEW.id, NEW.purchase_id, NEW.game_server_id, NEW.currency, NEW.buyer_character_id, NEW.seller_character_id, NEW.amount, NEW.reservation_transaction_id, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.purchase_id, OLD.game_server_id, OLD.currency, OLD.buyer_character_id, OLD.seller_character_id, OLD.amount, OLD.reservation_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'marketplace escrows are append-only once resolved' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER player_marketplace_currency_escrows_guard
        BEFORE UPDATE OR DELETE ON player_marketplace_currency_escrows
        FOR EACH ROW EXECUTE FUNCTION guard_player_marketplace_escrow();
      CREATE FUNCTION reject_player_marketplace_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER player_marketplace_requests_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON player_marketplace_requests
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_marketplace_history_mutation();
      CREATE TRIGGER player_marketplace_custody_events_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON player_marketplace_custody_events
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_marketplace_history_mutation();
      CREATE TRIGGER player_marketplace_settlement_events_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON player_marketplace_settlement_events
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_marketplace_history_mutation();
      CREATE TRIGGER player_marketplace_listings_truncate
        BEFORE TRUNCATE ON player_marketplace_listings
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_marketplace_history_mutation();
      CREATE TRIGGER player_marketplace_purchases_truncate
        BEFORE TRUNCATE ON player_marketplace_purchases
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_marketplace_history_mutation();
      CREATE TRIGGER player_marketplace_currency_escrows_truncate
        BEFORE TRUNCATE ON player_marketplace_currency_escrows
        FOR EACH STATEMENT EXECUTE FUNCTION reject_player_marketplace_history_mutation();
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to erase listings or escrow bookkeeping backed by the ledger.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM player_marketplace_listings) OR EXISTS (SELECT 1 FROM economy_accounts WHERE system_key = 'MARKET_ESCROW') THEN
          RAISE EXCEPTION 'marketplace listings exist; refusing to drop them' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE player_marketplace_settlement_events;
      DROP TABLE player_marketplace_custody_events;
      DROP TABLE player_marketplace_requests;
      DROP TABLE player_marketplace_currency_escrows;
      DROP TABLE player_marketplace_purchases;
      DROP TABLE player_marketplace_listings;
      DROP FUNCTION reject_player_marketplace_history_mutation();
      DROP FUNCTION guard_player_marketplace_escrow();
      DROP FUNCTION guard_player_marketplace_purchase();
      DROP FUNCTION guard_player_marketplace_listing();
      ALTER TABLE economy_accounts
        DROP CONSTRAINT economy_accounts_owner_check,
        ADD CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN', 'TRADE_ESCROW')));
    `);
  }
}
