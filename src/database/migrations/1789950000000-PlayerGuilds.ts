import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerGuilds1789950000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Persistent guilds keyed by character identity; history is never deleted.
    await queryRunner.query(`
      CREATE TABLE player_guilds (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        name varchar(48) NOT NULL,
        name_key text NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disbanded_at timestamptz,
        CONSTRAINT player_guilds_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_guilds_id_server_key UNIQUE (id, game_server_id),
        CONSTRAINT player_guilds_status_check CHECK (status IN ('ACTIVE', 'DISBANDED')),
        CONSTRAINT player_guilds_disbanded_check CHECK ((status = 'DISBANDED') = (disbanded_at IS NOT NULL)),
        CONSTRAINT player_guilds_name_check CHECK (char_length(name) BETWEEN 3 AND 48 AND name = btrim(name) AND char_length(name_key) > 0)
      );
      CREATE UNIQUE INDEX player_guilds_name_key ON player_guilds(game_server_id, name_key) WHERE status = 'ACTIVE';
      CREATE TABLE player_guild_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        guild_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        character_external_id varchar(128) NOT NULL,
        role varchar(16) NOT NULL,
        joined_at timestamptz NOT NULL,
        left_at timestamptz,
        CONSTRAINT player_guild_members_guild_fkey FOREIGN KEY (guild_id, game_server_id) REFERENCES player_guilds(id, game_server_id),
        CONSTRAINT player_guild_members_role_check CHECK (role IN ('MASTER', 'OFFICER', 'MEMBER')),
        CONSTRAINT player_guild_members_left_check CHECK (left_at IS NULL OR left_at >= joined_at),
        CONSTRAINT player_guild_members_character_check CHECK (length(btrim(character_external_id)) > 0)
      );
      CREATE UNIQUE INDEX player_guild_members_active_key ON player_guild_members(game_server_id, character_external_id) WHERE left_at IS NULL;
      CREATE UNIQUE INDEX player_guild_members_master_key ON player_guild_members(guild_id) WHERE role = 'MASTER' AND left_at IS NULL;
      CREATE INDEX player_guild_members_guild_idx ON player_guild_members(guild_id);
      CREATE TABLE player_guild_invites (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        guild_id uuid NOT NULL,
        game_server_id uuid NOT NULL,
        target_character_external_id varchar(128) NOT NULL,
        invited_by_character_external_id varchar(128) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        expires_at timestamptz NOT NULL,
        responded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_guild_invites_guild_fkey FOREIGN KEY (guild_id, game_server_id) REFERENCES player_guilds(id, game_server_id),
        CONSTRAINT player_guild_invites_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
        CONSTRAINT player_guild_invites_responded_check CHECK ((status = 'PENDING') = (responded_at IS NULL)),
        CONSTRAINT player_guild_invites_expiry_check CHECK (expires_at > created_at),
        CONSTRAINT player_guild_invites_character_check CHECK (length(btrim(target_character_external_id)) > 0 AND length(btrim(invited_by_character_external_id)) > 0)
      );
      CREATE UNIQUE INDEX player_guild_invites_pending_key ON player_guild_invites(guild_id, target_character_external_id) WHERE status = 'PENDING';
      CREATE INDEX player_guild_invites_target_idx ON player_guild_invites(game_server_id, target_character_external_id, status);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE player_guild_invites;
      DROP TABLE player_guild_members;
      DROP TABLE player_guilds;
    `);
  }
}
