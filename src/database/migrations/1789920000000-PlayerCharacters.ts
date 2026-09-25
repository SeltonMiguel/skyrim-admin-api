import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerCharacters1789920000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Backend-owned ownership links; no GameCommand involvement.
    await queryRunner.query(`
      CREATE TABLE player_characters (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        character_external_id varchar(128) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        verified_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_characters_player_fkey FOREIGN KEY (player_id) REFERENCES players(id),
        CONSTRAINT player_characters_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_characters_link_key UNIQUE (player_id, game_server_id, character_external_id),
        CONSTRAINT player_characters_status_check CHECK (status IN ('PENDING', 'VERIFIED', 'REVOKED')),
        CONSTRAINT player_characters_character_check CHECK (length(btrim(character_external_id)) > 0),
        CONSTRAINT player_characters_lifecycle_check CHECK ((status = 'PENDING' AND verified_at IS NULL AND revoked_at IS NULL) OR (status = 'VERIFIED' AND verified_at IS NOT NULL AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX player_characters_verified_key ON player_characters(game_server_id, character_external_id) WHERE status = 'VERIFIED';
      CREATE INDEX player_characters_player_idx ON player_characters(player_id, status);
      CREATE TABLE player_character_link_challenges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        player_character_id uuid NOT NULL,
        challenge_hash varchar(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_character_link_challenges_link_fkey FOREIGN KEY (player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_character_link_challenges_hash_key UNIQUE (challenge_hash),
        CONSTRAINT player_character_link_challenges_hash_check CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT player_character_link_challenges_final_check CHECK (consumed_at IS NULL OR revoked_at IS NULL),
        CONSTRAINT player_character_link_challenges_expiry_check CHECK (expires_at > created_at)
      );
      CREATE UNIQUE INDEX player_character_link_challenges_active_key ON player_character_link_challenges(player_character_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
      CREATE INDEX player_character_link_challenges_link_idx ON player_character_link_challenges(player_character_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE player_character_link_challenges;
      DROP TABLE player_characters;
    `);
  }
}
