import type { MigrationInterface, QueryRunner } from 'typeorm';

// Etapa 11.3: Server Control over the Host Agent. Adds the terminal
// UNCERTAIN status, the claim's target session and persistent deadlines
// (notAfter sent to the Agent, result deadline reconciled after restarts)
// and at most one non-terminal operation per server.
export class ServerControlTransport1790030000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE server_control_operations
        ADD COLUMN dispatch_connection_id uuid,
        ADD COLUMN not_after timestamptz,
        ADD COLUMN result_deadline_at timestamptz,
        ADD CONSTRAINT server_control_operations_connection_fkey FOREIGN KEY (dispatch_connection_id) REFERENCES game_connections(id),
        DROP CONSTRAINT server_control_operations_status_check,
        DROP CONSTRAINT server_control_operations_completed_check,
        DROP CONSTRAINT server_control_operations_error_check;

      -- Before 11.3 nothing could report a result. Claimed work was possibly
      -- delivered: its outcome is unknown. Unclaimed work was never sent:
      -- failing it is safe (a new request is needed).
      UPDATE server_control_operations
        SET status = 'UNCERTAIN', error_code = 'RESULT_TIMEOUT', completed_at = now(),
            not_after = dispatch_claimed_at, result_deadline_at = dispatch_claimed_at
        WHERE status IN ('PENDING', 'DISPATCHED') AND dispatch_claimed_at IS NOT NULL;
      UPDATE server_control_operations
        SET status = 'FAILED', error_code = 'DISPATCH_EXPIRED', completed_at = now()
        WHERE status = 'PENDING';
      UPDATE server_control_operations
        SET not_after = dispatch_claimed_at, result_deadline_at = dispatch_claimed_at
        WHERE dispatch_claimed_at IS NOT NULL AND not_after IS NULL;

      ALTER TABLE server_control_operations
        ADD CONSTRAINT server_control_operations_status_check CHECK (status IN ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'UNCERTAIN')),
        ADD CONSTRAINT server_control_operations_completed_check CHECK ((status IN ('SUCCEEDED', 'FAILED', 'UNCERTAIN')) = (completed_at IS NOT NULL)),
        ADD CONSTRAINT server_control_operations_error_check CHECK ((status IN ('FAILED', 'UNCERTAIN')) = (error_code IS NOT NULL)),
        ADD CONSTRAINT server_control_operations_claim_check CHECK ((dispatch_claimed_at IS NULL) = (not_after IS NULL) AND (dispatch_claimed_at IS NULL) = (result_deadline_at IS NULL) AND (dispatch_claimed_at IS NOT NULL OR dispatch_connection_id IS NULL)),
        ADD CONSTRAINT server_control_operations_uncertain_check CHECK (status <> 'UNCERTAIN' OR dispatch_claimed_at IS NOT NULL);
      CREATE UNIQUE INDEX server_control_operations_active_key ON server_control_operations(game_server_id) WHERE status IN ('PENDING', 'DISPATCHED');
      CREATE INDEX server_control_operations_deadline_idx ON server_control_operations(status, result_deadline_at);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // The Etapa 09 schema has no UNCERTAIN: it becomes the old "possibly
    // delivered, never resent" DISPATCHED. New failure codes map to the old
    // catalog. Stop the application before reverting.
    await queryRunner.query(`
      DROP INDEX server_control_operations_deadline_idx;
      DROP INDEX server_control_operations_active_key;
      ALTER TABLE server_control_operations
        DROP CONSTRAINT server_control_operations_uncertain_check,
        DROP CONSTRAINT server_control_operations_claim_check,
        DROP CONSTRAINT server_control_operations_error_check,
        DROP CONSTRAINT server_control_operations_completed_check,
        DROP CONSTRAINT server_control_operations_status_check;
      UPDATE server_control_operations
        SET status = 'DISPATCHED', error_code = NULL, completed_at = NULL,
            dispatched_at = COALESCE(dispatched_at, dispatch_claimed_at)
        WHERE status = 'UNCERTAIN';
      UPDATE server_control_operations SET error_code = 'AGENT_UNAVAILABLE'
        WHERE error_code = 'DISPATCH_EXPIRED';
      UPDATE server_control_operations SET error_code = 'AGENT_REJECTED'
        WHERE error_code IN ('DELIVERY_EXPIRED', 'INVALID_PROCESS_STATE', 'EXECUTION_FAILED');
      ALTER TABLE server_control_operations
        DROP CONSTRAINT server_control_operations_connection_fkey,
        DROP COLUMN result_deadline_at,
        DROP COLUMN not_after,
        DROP COLUMN dispatch_connection_id,
        ADD CONSTRAINT server_control_operations_status_check CHECK (status IN ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED')),
        ADD CONSTRAINT server_control_operations_completed_check CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (completed_at IS NOT NULL)),
        ADD CONSTRAINT server_control_operations_error_check CHECK ((status = 'FAILED') = (error_code IS NOT NULL));
    `);
  }
}
