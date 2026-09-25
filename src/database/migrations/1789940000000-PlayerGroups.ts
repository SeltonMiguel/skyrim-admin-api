import type { MigrationInterface, QueryRunner } from 'typeorm';
export class PlayerGroups1789940000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Temporary parties of ownership links; history is never deleted.
    await queryRunner.query(`
      CREATE TABLE player_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        disbanded_at timestamptz,
        CONSTRAINT player_groups_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT player_groups_status_check CHECK (status IN ('ACTIVE', 'DISBANDED')),
        CONSTRAINT player_groups_disbanded_check CHECK ((status = 'DISBANDED') = (disbanded_at IS NOT NULL))
      );
      CREATE INDEX player_groups_server_idx ON player_groups(game_server_id, status);
      CREATE TABLE player_group_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL,
        player_character_id uuid NOT NULL,
        role varchar(16) NOT NULL,
        joined_at timestamptz NOT NULL,
        left_at timestamptz,
        CONSTRAINT player_group_members_group_fkey FOREIGN KEY (group_id) REFERENCES player_groups(id),
        CONSTRAINT player_group_members_character_fkey FOREIGN KEY (player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_group_members_role_check CHECK (role IN ('LEADER', 'MEMBER')),
        CONSTRAINT player_group_members_left_check CHECK (left_at IS NULL OR left_at >= joined_at)
      );
      CREATE UNIQUE INDEX player_group_members_active_key ON player_group_members(player_character_id) WHERE left_at IS NULL;
      CREATE UNIQUE INDEX player_group_members_leader_key ON player_group_members(group_id) WHERE role = 'LEADER' AND left_at IS NULL;
      CREATE INDEX player_group_members_group_idx ON player_group_members(group_id);
      CREATE TABLE player_group_invites (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL,
        target_player_character_id uuid NOT NULL,
        invited_by_player_character_id uuid NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        expires_at timestamptz NOT NULL,
        responded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT player_group_invites_group_fkey FOREIGN KEY (group_id) REFERENCES player_groups(id),
        CONSTRAINT player_group_invites_target_fkey FOREIGN KEY (target_player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_group_invites_inviter_fkey FOREIGN KEY (invited_by_player_character_id) REFERENCES player_characters(id),
        CONSTRAINT player_group_invites_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
        CONSTRAINT player_group_invites_responded_check CHECK ((status = 'PENDING') = (responded_at IS NULL)),
        CONSTRAINT player_group_invites_expiry_check CHECK (expires_at > created_at)
      );
      CREATE UNIQUE INDEX player_group_invites_pending_key ON player_group_invites(group_id, target_player_character_id) WHERE status = 'PENDING';
      CREATE INDEX player_group_invites_target_idx ON player_group_invites(target_player_character_id, status);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE player_group_invites;
      DROP TABLE player_group_members;
      DROP TABLE player_groups;
    `);
  }
}
