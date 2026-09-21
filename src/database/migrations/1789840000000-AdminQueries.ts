import type { MigrationInterface, QueryRunner } from 'typeorm';

// Frozen grants: independent of future runtime permission definitions.
export class AdminQueries1789840000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions(name) VALUES ('DASHBOARD_READ'), ('GAME_BRIDGE_READ');
      INSERT INTO role_permissions(role_name, permission_name)
      SELECT role_name, permission_name
      FROM (VALUES ('COORDINATOR'), ('GENERAL_CHIEF'), ('ADMIN'),
                   ('MODERATOR'), ('SUPPORT'), ('DEV')) AS roles(role_name)
      CROSS JOIN (VALUES ('DASHBOARD_READ'), ('GAME_BRIDGE_READ')) AS permissions(permission_name);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permissions
      WHERE permission_name IN ('DASHBOARD_READ', 'GAME_BRIDGE_READ')
        AND role_name IN ('COORDINATOR', 'GENERAL_CHIEF', 'ADMIN', 'MODERATOR', 'SUPPORT', 'DEV');
      DELETE FROM permissions WHERE name IN ('DASHBOARD_READ', 'GAME_BRIDGE_READ');
    `);
  }
}
