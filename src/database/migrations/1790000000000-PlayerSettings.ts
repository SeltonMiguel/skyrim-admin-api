import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerSettings1790000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // One row per player (primary key = player), no cascade: a player row is
    // never deleted. Absent row = defaults.
    await queryRunner.query(`
      CREATE TABLE player_settings (
        player_id uuid PRIMARY KEY,
        locale varchar(35) NOT NULL,
        time_zone varchar(64) NOT NULL,
        allow_direct_messages boolean NOT NULL DEFAULT true,
        allow_trade_requests boolean NOT NULL DEFAULT true,
        allow_group_invites boolean NOT NULL DEFAULT true,
        allow_guild_invites boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_settings_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_settings_locale_check CHECK (char_length(locale) BETWEEN 1 AND 35 AND locale ~ '^[A-Za-z0-9-]+$'),
        CONSTRAINT player_settings_time_zone_check CHECK (char_length(time_zone) BETWEEN 1 AND 64 AND time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$')
      );
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to silently discard choices players made.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM player_settings) THEN
          RAISE EXCEPTION 'player settings exist; refusing to drop them' USING ERRCODE = '55000';
        END IF;
      END;
      $$;
      DROP TABLE player_settings;
    `);
  }
}
