import type { MigrationInterface, QueryRunner } from 'typeorm';

// Frozen seed snapshot: future permission changes require a new migration.
export class AuthRbac1789810000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE roles (name varchar(32) PRIMARY KEY);
      CREATE TABLE permissions (name varchar(64) PRIMARY KEY);
      CREATE TABLE role_permissions (
        role_name varchar(32) NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
        permission_name varchar(64) NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
        PRIMARY KEY (role_name, permission_name)
      );
      CREATE TABLE staff_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username varchar(64) NOT NULL UNIQUE,
        display_name varchar(100) NOT NULL,
        password_hash text NOT NULL,
        role_name varchar(32) NOT NULL REFERENCES roles(name),
        status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT staff_username_normalized CHECK (username ~ '^[a-z0-9_.-]{3,64}$')
      );
      CREATE INDEX staff_users_role_status_idx ON staff_users(role_name, status);
      CREATE TABLE staff_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        staff_user_id uuid NOT NULL REFERENCES staff_users(id),
        refresh_token_hash varchar(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        last_used_at timestamptz,
        ip_address varchar(64),
        user_agent varchar(512),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX staff_sessions_user_idx ON staff_sessions(staff_user_id);
    `);
    await queryRunner.query(
      "INSERT INTO roles (name) VALUES ('COORDINATOR') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO roles (name) VALUES ('GENERAL_CHIEF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO roles (name) VALUES ('ADMIN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO roles (name) VALUES ('MODERATOR') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO roles (name) VALUES ('SUPPORT') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO roles (name) VALUES ('DEV') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('STAFF_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('STAFF_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('VIP_STORE_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('SERVER_START') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('SERVER_PAUSE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('SERVER_RESTART') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_INVENTORY_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_INVENTORY_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_PROPERTY_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_PROPERTY_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_HOLD_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_HOLD_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_HORSE_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_HORSE_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_ITEM_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_HORSE_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_TITLE_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('CHARACTER_SPELL_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('FACTION_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('FACTION_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('PLAYER_BAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('PLAYER_UNBAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('PLAYER_GOD_MODE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('STAFF_NOCLIP') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('STAFF_INVISIBILITY') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('AUDIT_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('ANNOUNCEMENT_SEND') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('STAFF_TELEPORT_TO_PLAYER') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO permissions (name) VALUES ('PLAYER_TELEPORT_TO_STAFF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'STAFF_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'STAFF_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'VIP_STORE_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'SERVER_START') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'SERVER_PAUSE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'SERVER_RESTART') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_INVENTORY_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_INVENTORY_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_PROPERTY_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_PROPERTY_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_HOLD_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_HOLD_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_HORSE_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_HORSE_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_ITEM_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_HORSE_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_TITLE_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'CHARACTER_SPELL_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'FACTION_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'FACTION_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'PLAYER_BAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'PLAYER_UNBAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'PLAYER_GOD_MODE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'STAFF_NOCLIP') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'STAFF_INVISIBILITY') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'AUDIT_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'ANNOUNCEMENT_SEND') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'STAFF_TELEPORT_TO_PLAYER') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('COORDINATOR', 'PLAYER_TELEPORT_TO_STAFF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_INVENTORY_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_INVENTORY_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_PROPERTY_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_PROPERTY_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_HOLD_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_HOLD_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_HORSE_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_HORSE_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_ITEM_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_HORSE_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_TITLE_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'CHARACTER_SPELL_GIVE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'FACTION_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'FACTION_WRITE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'PLAYER_BAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'PLAYER_UNBAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'PLAYER_GOD_MODE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'STAFF_NOCLIP') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'STAFF_INVISIBILITY') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'AUDIT_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'ANNOUNCEMENT_SEND') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'STAFF_TELEPORT_TO_PLAYER') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('GENERAL_CHIEF', 'PLAYER_TELEPORT_TO_STAFF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'PLAYER_BAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'PLAYER_UNBAN') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'PLAYER_GOD_MODE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'STAFF_NOCLIP') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'STAFF_INVISIBILITY') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'AUDIT_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'ANNOUNCEMENT_SEND') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'STAFF_TELEPORT_TO_PLAYER') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('ADMIN', 'PLAYER_TELEPORT_TO_STAFF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('MODERATOR', 'STAFF_NOCLIP') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('MODERATOR', 'STAFF_INVISIBILITY') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('MODERATOR', 'AUDIT_READ') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('MODERATOR', 'ANNOUNCEMENT_SEND') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('MODERATOR', 'STAFF_TELEPORT_TO_PLAYER') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('MODERATOR', 'PLAYER_TELEPORT_TO_STAFF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('SUPPORT', 'PLAYER_TELEPORT_TO_STAFF') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('DEV', 'SERVER_START') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('DEV', 'SERVER_PAUSE') ON CONFLICT DO NOTHING",
    );
    await queryRunner.query(
      "INSERT INTO role_permissions (role_name, permission_name) VALUES ('DEV', 'SERVER_RESTART') ON CONFLICT DO NOTHING",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE staff_sessions;
      DROP TABLE staff_users;
      DROP TABLE role_permissions;
      DROP TABLE permissions;
      DROP TABLE roles;
    `);
  }
}
