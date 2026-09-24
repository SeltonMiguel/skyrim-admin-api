import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Economy1789960000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Backend-owned double-entry ledger keyed by character identity. The
    // ledger is append-only; account balances are a projection maintained
    // by the database from the entries, in the same transaction.
    await queryRunner.query(`
      CREATE TABLE economy_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        currency varchar(16) NOT NULL,
        owner_type varchar(16) NOT NULL,
        character_external_id varchar(128),
        system_key varchar(32),
        balance bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT economy_accounts_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT economy_accounts_ledger_key UNIQUE (id, game_server_id, currency),
        CONSTRAINT economy_accounts_currency_check CHECK (currency IN ('GOLD')),
        CONSTRAINT economy_accounts_owner_check CHECK ((owner_type = 'CHARACTER' AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0 AND system_key IS NULL) OR (owner_type = 'SYSTEM' AND character_external_id IS NULL AND system_key IN ('MINT', 'BURN'))),
        CONSTRAINT economy_accounts_balance_check CHECK ((owner_type = 'CHARACTER' AND balance BETWEEN 0 AND 1000000000000) OR (owner_type = 'SYSTEM' AND balance BETWEEN -9000000000000000 AND 9000000000000000))
      );
      CREATE UNIQUE INDEX economy_accounts_character_key ON economy_accounts(game_server_id, currency, character_external_id) WHERE owner_type = 'CHARACTER';
      CREATE UNIQUE INDEX economy_accounts_system_key ON economy_accounts(game_server_id, currency, system_key) WHERE owner_type = 'SYSTEM';
      CREATE TABLE economy_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        currency varchar(16) NOT NULL,
        type varchar(32) NOT NULL,
        actor_type varchar(16) NOT NULL,
        actor_player_id uuid,
        actor_staff_id uuid,
        actor_system_source varchar(32),
        idempotency_scope varchar(64) NOT NULL,
        idempotency_key varchar(128) NOT NULL,
        request_fingerprint char(64) NOT NULL,
        reference_type varchar(32),
        reference_id varchar(128),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT economy_transactions_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT economy_transactions_player_fkey FOREIGN KEY (actor_player_id) REFERENCES players(id),
        CONSTRAINT economy_transactions_staff_fkey FOREIGN KEY (actor_staff_id) REFERENCES staff_users(id),
        CONSTRAINT economy_transactions_ledger_key UNIQUE (id, game_server_id, currency),
        CONSTRAINT economy_transactions_idempotency_key UNIQUE (game_server_id, idempotency_scope, idempotency_key),
        CONSTRAINT economy_transactions_currency_check CHECK (currency IN ('GOLD')),
        CONSTRAINT economy_transactions_type_check CHECK (type IN ('SYSTEM_CREDIT', 'SYSTEM_DEBIT', 'TRANSFER') AND (type = 'TRANSFER' OR actor_type = 'SYSTEM')),
        CONSTRAINT economy_transactions_actor_check CHECK ((actor_type = 'STAFF' AND actor_staff_id IS NOT NULL AND actor_player_id IS NULL AND actor_system_source IS NULL AND idempotency_scope = 'STAFF') OR (actor_type = 'PLAYER' AND actor_player_id IS NOT NULL AND actor_staff_id IS NULL AND actor_system_source IS NULL AND idempotency_scope = ('PLAYER:' || actor_player_id::text)) OR (actor_type = 'SYSTEM' AND actor_system_source IN ('AGENT', 'PROFESSION', 'VIP_DELIVERY') AND actor_staff_id IS NULL AND actor_player_id IS NULL AND idempotency_scope = ('SYSTEM:' || actor_system_source))),
        CONSTRAINT economy_transactions_key_check CHECK (length(idempotency_key) > 0),
        CONSTRAINT economy_transactions_reference_check CHECK ((reference_type IS NULL) = (reference_id IS NULL))
      );
      CREATE TABLE economy_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id uuid NOT NULL,
        account_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        currency varchar(16) NOT NULL,
        amount bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT economy_entries_transaction_fkey FOREIGN KEY (transaction_id, game_server_id, currency) REFERENCES economy_transactions(id, game_server_id, currency),
        CONSTRAINT economy_entries_account_fkey FOREIGN KEY (account_id, game_server_id, currency) REFERENCES economy_accounts(id, game_server_id, currency),
        CONSTRAINT economy_entries_leg_key UNIQUE (transaction_id, account_id),
        CONSTRAINT economy_entries_amount_check CHECK (amount <> 0 AND amount BETWEEN -1000000000000 AND 1000000000000)
      );
      CREATE INDEX economy_entries_account_idx ON economy_entries(account_id, created_at);

      -- Append-only ledger, like audit_logs.
      CREATE FUNCTION reject_economy_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER economy_transactions_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON economy_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION reject_economy_ledger_mutation();
      ALTER TABLE economy_transactions ENABLE ALWAYS TRIGGER economy_transactions_immutable;
      CREATE TRIGGER economy_entries_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON economy_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_economy_ledger_mutation();
      ALTER TABLE economy_entries ENABLE ALWAYS TRIGGER economy_entries_immutable;

      -- Every transaction must balance (sum = 0, at least two legs) at commit.
      CREATE FUNCTION check_economy_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        tx uuid;
        total numeric;
        legs integer;
      BEGIN
        IF TG_TABLE_NAME = 'economy_transactions' THEN
          tx := NEW.id;
        ELSE
          tx := NEW.transaction_id;
        END IF;
        SELECT coalesce(sum(amount), 0), count(*) INTO total, legs
          FROM economy_entries WHERE transaction_id = tx;
        IF legs < 2 OR total <> 0 THEN
          RAISE EXCEPTION 'economy transaction % is not balanced', tx USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$;
      CREATE CONSTRAINT TRIGGER economy_transactions_balanced
        AFTER INSERT ON economy_transactions DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_economy_transaction_balanced();
      ALTER TABLE economy_transactions ENABLE ALWAYS TRIGGER economy_transactions_balanced;
      CREATE CONSTRAINT TRIGGER economy_entries_balanced
        AFTER INSERT ON economy_entries DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION check_economy_transaction_balanced();
      ALTER TABLE economy_entries ENABLE ALWAYS TRIGGER economy_entries_balanced;

      -- Balance projection: only an entry moves a balance (nested trigger),
      -- accounts start at zero, identity is immutable and rows stay.
      CREATE FUNCTION apply_economy_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE economy_accounts SET balance = balance + NEW.amount, updated_at = now()
          WHERE id = NEW.account_id;
        RETURN NULL;
      END;
      $$;
      CREATE TRIGGER economy_entries_apply
        AFTER INSERT ON economy_entries
        FOR EACH ROW EXECUTE FUNCTION apply_economy_entry();
      ALTER TABLE economy_entries ENABLE ALWAYS TRIGGER economy_entries_apply;
      CREATE FUNCTION guard_economy_account() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.balance <> 0 THEN
            RAISE EXCEPTION 'economy accounts start at zero' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF (NEW.id, NEW.game_server_id, NEW.currency, NEW.owner_type, NEW.character_external_id, NEW.system_key, NEW.created_at)
            IS DISTINCT FROM (OLD.id, OLD.game_server_id, OLD.currency, OLD.owner_type, OLD.character_external_id, OLD.system_key, OLD.created_at)
            OR (NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2) THEN
            RAISE EXCEPTION 'economy account balances change only through ledger entries' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'economy accounts cannot be removed' USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER economy_accounts_guard
        BEFORE INSERT OR UPDATE OR DELETE ON economy_accounts
        FOR EACH ROW EXECUTE FUNCTION guard_economy_account();
      ALTER TABLE economy_accounts ENABLE ALWAYS TRIGGER economy_accounts_guard;
      CREATE TRIGGER economy_accounts_truncate
        BEFORE TRUNCATE ON economy_accounts
        FOR EACH STATEMENT EXECUTE FUNCTION reject_economy_ledger_mutation();
      ALTER TABLE economy_accounts ENABLE ALWAYS TRIGGER economy_accounts_truncate;
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to erase financial history: the ledger is the source of truth.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM economy_transactions) THEN
          RAISE EXCEPTION 'economy ledger is not empty; refusing to drop it' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE economy_entries;
      DROP TABLE economy_transactions;
      DROP TABLE economy_accounts;
      DROP FUNCTION guard_economy_account();
      DROP FUNCTION apply_economy_entry();
      DROP FUNCTION check_economy_transaction_balanced();
      DROP FUNCTION reject_economy_ledger_mutation();
    `);
  }
}
