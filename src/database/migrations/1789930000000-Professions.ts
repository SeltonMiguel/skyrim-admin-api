import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Professions1789930000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Backend-owned profession state per character (server + character id),
    // independent of ownership links; no GameCommand.
    await queryRunner.query(`
      CREATE TABLE character_professions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        character_external_id varchar(128) NOT NULL,
        profession varchar(32) NOT NULL,
        experience bigint NOT NULL DEFAULT 0,
        level integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT character_professions_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT character_professions_character_key UNIQUE (game_server_id, character_external_id),
        CONSTRAINT character_professions_character_check CHECK (length(btrim(character_external_id)) > 0),
        CONSTRAINT character_professions_profession_check CHECK (profession IN ('TAILOR', 'HUNTER', 'MINER', 'BLACKSMITH', 'ALCHEMIST', 'CHARCOAL_BURNER', 'COOK')),
        CONSTRAINT character_professions_experience_check CHECK (experience >= 0 AND experience <= 1000000000000),
        CONSTRAINT character_professions_level_check CHECK (level BETWEEN 1 AND 100),
        CONSTRAINT character_professions_progression_check CHECK (experience >= 100 * (level - 1)::bigint * (level - 1) AND (level = 100 OR experience < 100 * level::bigint * level))
      );
      CREATE TABLE profession_experience_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        character_profession_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        external_event_id varchar(128) NOT NULL,
        amount integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT profession_experience_events_profession_fkey FOREIGN KEY (character_profession_id) REFERENCES character_professions(id),
        CONSTRAINT profession_experience_events_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT profession_experience_events_event_key UNIQUE (game_server_id, external_event_id),
        CONSTRAINT profession_experience_events_amount_check CHECK (amount BETWEEN 1 AND 1000000),
        CONSTRAINT profession_experience_events_event_check CHECK (length(btrim(external_event_id)) > 0)
      );
      CREATE INDEX profession_experience_events_profession_idx ON profession_experience_events(character_profession_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE profession_experience_events;
      DROP TABLE character_professions;
    `);
  }
}
