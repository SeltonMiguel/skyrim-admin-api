import type { MigrationInterface, QueryRunner } from 'typeorm';
export class GenericActor1789900000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // audit_logs is append-only: only nullable columns and constraints are added.
    // No statement updates existing rows; historical rows keep actor_type NULL
    // and are interpreted as STAFF when actor_staff_id is set.
    await queryRunner.query(`
      ALTER TABLE audit_logs
        ADD COLUMN actor_type varchar(16),
        ADD COLUMN actor_player_id uuid,
        ADD COLUMN actor_system_source varchar(32),
        ADD CONSTRAINT audit_logs_actor_check CHECK ((actor_type IS NULL AND actor_player_id IS NULL AND actor_system_source IS NULL) OR (actor_type IS NOT NULL AND actor_type = 'STAFF' AND actor_staff_id IS NOT NULL AND actor_player_id IS NULL AND actor_system_source IS NULL) OR (actor_type IS NOT NULL AND actor_type = 'PLAYER' AND actor_player_id IS NOT NULL AND actor_staff_id IS NULL AND actor_username IS NULL AND actor_display_name IS NULL AND actor_role IS NULL AND actor_system_source IS NULL) OR (actor_type IS NOT NULL AND actor_type = 'SYSTEM' AND actor_system_source IS NOT NULL AND actor_system_source IN ('AGENT', 'PROFESSION', 'VIP_DELIVERY') AND actor_staff_id IS NULL AND actor_username IS NULL AND actor_display_name IS NULL AND actor_role IS NULL AND actor_player_id IS NULL));
      CREATE INDEX audit_logs_actor_player_idx ON audit_logs(actor_player_id);
    `);
    // Existing commands become STAFF-scoped through constant column defaults
    // (no rewrite of history); the shared staff idempotency semantics persist.
    await queryRunner.query(`
      ALTER TABLE game_commands
        ADD COLUMN idempotency_scope varchar(64) NOT NULL DEFAULT 'STAFF',
        ADD COLUMN actor_type varchar(16) NOT NULL DEFAULT 'STAFF',
        ADD COLUMN requested_by_player_id uuid,
        ADD COLUMN requested_by_system_source varchar(32),
        ADD CONSTRAINT game_commands_player_fkey FOREIGN KEY (requested_by_player_id) REFERENCES players(id),
        ADD CONSTRAINT game_commands_actor_check CHECK ((actor_type = 'STAFF' AND requested_by_player_id IS NULL AND requested_by_system_source IS NULL AND idempotency_scope = 'STAFF') OR (actor_type = 'PLAYER' AND requested_by_player_id IS NOT NULL AND requested_by_staff_id IS NULL AND requested_by_system_source IS NULL AND idempotency_scope = ('PLAYER:' || requested_by_player_id::text)) OR (actor_type = 'SYSTEM' AND requested_by_system_source IS NOT NULL AND requested_by_system_source IN ('AGENT', 'PROFESSION', 'VIP_DELIVERY') AND requested_by_staff_id IS NULL AND requested_by_player_id IS NULL AND idempotency_scope = ('SYSTEM:' || requested_by_system_source))),
        DROP CONSTRAINT game_commands_idempotency_key,
        ADD CONSTRAINT game_commands_idempotency_key UNIQUE (game_server_id, idempotency_scope, idempotency_key);
      CREATE INDEX game_commands_player_idx ON game_commands(requested_by_player_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to erase non-staff attribution or collapse scoped keys that would
    // collide under the old global constraint; nothing is deleted.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM game_commands WHERE actor_type <> 'STAFF')
          OR EXISTS (SELECT 1 FROM audit_logs WHERE actor_type IN ('PLAYER', 'SYSTEM')) THEN
          RAISE EXCEPTION 'PLAYER/SYSTEM actor data exists; GenericActor cannot be reverted'
            USING ERRCODE = '55000';
        END IF;
      END
      $$;
      DROP INDEX game_commands_player_idx;
      ALTER TABLE game_commands
        DROP CONSTRAINT game_commands_idempotency_key,
        ADD CONSTRAINT game_commands_idempotency_key UNIQUE (game_server_id, idempotency_key),
        DROP CONSTRAINT game_commands_actor_check,
        DROP CONSTRAINT game_commands_player_fkey,
        DROP COLUMN requested_by_system_source,
        DROP COLUMN requested_by_player_id,
        DROP COLUMN actor_type,
        DROP COLUMN idempotency_scope;
      DROP INDEX audit_logs_actor_player_idx;
      ALTER TABLE audit_logs
        DROP CONSTRAINT audit_logs_actor_check,
        DROP COLUMN actor_system_source,
        DROP COLUMN actor_player_id,
        DROP COLUMN actor_type;
    `);
  }
}
