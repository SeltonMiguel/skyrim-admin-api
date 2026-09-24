import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerSessions1789910000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Independent of staff_sessions; no provider tokens are ever stored.
    await queryRunner.query(`
      CREATE TABLE player_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id uuid NOT NULL,
        refresh_token_hash varchar(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_sessions_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_sessions_refresh_hash_check CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT player_sessions_expiry_check CHECK (expires_at > created_at)
      );
      CREATE INDEX player_sessions_player_idx ON player_sessions(player_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE player_sessions;`);
  }
}
