import type { MigrationInterface, QueryRunner } from 'typeorm';

// Etapa 11.1: Host Agent credentials (SHA-256 of a backend-generated secret,
// never plaintext), the Host Agent session fields of game_connections and
// the credential management permission (COORDINATOR, DEV).
export class GameAgentTransport1790020000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions(name) VALUES ('GAME_AGENT_CREDENTIAL_MANAGE');
      INSERT INTO role_permissions(role_name, permission_name)
      VALUES ('COORDINATOR', 'GAME_AGENT_CREDENTIAL_MANAGE'), ('DEV', 'GAME_AGENT_CREDENTIAL_MANAGE');

      CREATE TABLE game_agent_credentials (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        secret_hash char(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'ACTIVE',
        created_by_staff_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz,
        CONSTRAINT game_agent_credentials_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT game_agent_credentials_created_by_fkey FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id),
        CONSTRAINT game_agent_credentials_hash_check CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT game_agent_credentials_status_check CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
      );
      CREATE INDEX game_agent_credentials_server_idx ON game_agent_credentials(game_server_id, status);

      -- Identity, owner server and hash never change; only ACTIVE -> REVOKED,
      -- once, and last_used_at. Rows are kept as history.
      CREATE FUNCTION guard_game_agent_credential() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Game Agent credentials are kept as history' USING ERRCODE = '55000';
        END IF;
        IF (NEW.id, NEW.game_server_id, NEW.secret_hash, NEW.created_by_staff_id, NEW.created_at)
          IS DISTINCT FROM (OLD.id, OLD.game_server_id, OLD.secret_hash, OLD.created_by_staff_id, OLD.created_at)
          OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED'))
          OR (OLD.status = 'REVOKED' AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
          RAISE EXCEPTION 'invalid Game Agent credential change' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER game_agent_credentials_guard
        BEFORE UPDATE OR DELETE ON game_agent_credentials
        FOR EACH ROW EXECUTE FUNCTION guard_game_agent_credential();

      -- game_connections now represents the Host Agent session. bridge_version
      -- keeps the Agent version; existing rows have no credential or runtime.
      ALTER TABLE game_connections
        ADD COLUMN credential_id uuid,
        ADD COLUMN capabilities jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN game_process_state varchar(16),
        ADD COLUMN skse_ready boolean,
        ADD CONSTRAINT game_connections_credential_fkey FOREIGN KEY (credential_id) REFERENCES game_agent_credentials(id),
        ADD CONSTRAINT game_connections_reason_check CHECK (disconnect_reason IS NULL OR disconnect_reason IN ('SUPERSEDED', 'STALE', 'REQUESTED', 'CLOSED', 'CREDENTIAL_REVOKED', 'SHUTDOWN', 'BACKEND_RESTART')),
        ADD CONSTRAINT game_connections_agent_check CHECK ((credential_id IS NULL AND game_process_state IS NULL AND skse_ready IS NULL) OR (credential_id IS NOT NULL AND game_process_state IN ('UNKNOWN', 'STOPPED', 'STARTING', 'RUNNING', 'PAUSED', 'STOPPING', 'RESTARTING') AND skse_ready IS NOT NULL)),
        ADD CONSTRAINT game_connections_capabilities_check CHECK (CASE WHEN jsonb_typeof(capabilities) = 'array' THEN jsonb_array_length(capabilities) <= 64 ELSE false END);
      CREATE INDEX game_connections_credential_idx ON game_connections(credential_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Credentials (and the Agent sessions that reference them) are history:
    // refuse instead of silently dropping them. Legacy sessions only lose the
    // new columns; their disconnect reasons were never constrained before.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM game_agent_credentials) THEN
          RAISE EXCEPTION 'Game Agent credentials exist';
        END IF;
      END;
      $$;
      DROP INDEX game_connections_credential_idx;
      ALTER TABLE game_connections
        DROP CONSTRAINT game_connections_capabilities_check,
        DROP CONSTRAINT game_connections_agent_check,
        DROP CONSTRAINT game_connections_reason_check,
        DROP CONSTRAINT game_connections_credential_fkey,
        DROP COLUMN skse_ready,
        DROP COLUMN game_process_state,
        DROP COLUMN capabilities,
        DROP COLUMN credential_id;
      DROP TRIGGER game_agent_credentials_guard ON game_agent_credentials;
      DROP FUNCTION guard_game_agent_credential();
      DROP TABLE game_agent_credentials;
      DELETE FROM role_permissions WHERE permission_name = 'GAME_AGENT_CREDENTIAL_MANAGE';
      DELETE FROM permissions WHERE name = 'GAME_AGENT_CREDENTIAL_MANAGE';
    `);
  }
}
