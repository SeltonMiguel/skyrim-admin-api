import type { MigrationInterface, QueryRunner } from 'typeorm';

// Frozen incremental grants; no World state is stored locally.
export class WorldPermissions1789860000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO permissions(name) VALUES ('WORLD_READ'), ('WORLD_TIME_WRITE'), ('WORLD_WEATHER_WRITE'), ('WORLD_ENTITY_SPAWN');
      INSERT INTO role_permissions(role_name, permission_name)
      SELECT role_name, permission_name
      FROM (VALUES ('COORDINATOR'), ('GENERAL_CHIEF')) AS roles(role_name)
      CROSS JOIN (VALUES ('WORLD_READ'), ('WORLD_TIME_WRITE'), ('WORLD_WEATHER_WRITE'), ('WORLD_ENTITY_SPAWN')) AS permissions(permission_name);
      INSERT INTO role_permissions(role_name, permission_name) VALUES ('ADMIN', 'WORLD_READ');
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permissions WHERE permission_name IN ('WORLD_READ', 'WORLD_TIME_WRITE', 'WORLD_WEATHER_WRITE', 'WORLD_ENTITY_SPAWN');
      DELETE FROM permissions WHERE name IN ('WORLD_READ', 'WORLD_TIME_WRITE', 'WORLD_WEATHER_WRITE', 'WORLD_ENTITY_SPAWN');
    `);
  }
}
