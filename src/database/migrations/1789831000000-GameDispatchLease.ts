import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GameDispatchLease1789831000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE game_commands
        ADD COLUMN dispatch_lease_id uuid,
        ADD COLUMN dispatch_lease_expires_at timestamptz,
        ADD CONSTRAINT game_commands_dispatch_lease_check
          CHECK ((dispatch_lease_id IS NULL) = (dispatch_lease_expires_at IS NULL));
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE game_commands
        DROP CONSTRAINT game_commands_dispatch_lease_check,
        DROP COLUMN dispatch_lease_expires_at,
        DROP COLUMN dispatch_lease_id;
    `);
  }
}
