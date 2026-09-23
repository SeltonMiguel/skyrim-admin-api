import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CharacterResultLimit1789850000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE game_command_results DROP CONSTRAINT game_command_results_size_check;
      ALTER TABLE game_command_results ADD CONSTRAINT game_command_results_size_check
        CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536));
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // Fails transactionally if larger results exist; never truncate/delete them.
    await queryRunner.query(`
      ALTER TABLE game_command_results DROP CONSTRAINT game_command_results_size_check;
      ALTER TABLE game_command_results ADD CONSTRAINT game_command_results_size_check
        CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096));
    `);
  }
}
