import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerAccounts1789890000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Player identity is independent of staff_users, staff_sessions and RBAC.
    await queryRunner.query(`
      CREATE TABLE players (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status varchar(16) NOT NULL DEFAULT 'ACTIVE',
        display_name varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT players_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED')),
        CONSTRAINT players_display_name_check CHECK (length(btrim(display_name)) > 0)
      );
      CREATE TABLE player_identities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id uuid NOT NULL,
        provider varchar(32) NOT NULL,
        provider_subject varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_identities_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_identities_provider_subject_key UNIQUE (provider, provider_subject),
        CONSTRAINT player_identities_provider_check CHECK (provider IN ('DISCORD', 'STEAM')),
        CONSTRAINT player_identities_subject_check CHECK (length(btrim(provider_subject)) > 0)
      );
      CREATE INDEX player_identities_player_idx ON player_identities(player_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE player_identities;
      DROP TABLE players;
    `);
  }
}
