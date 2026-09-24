import type { MigrationInterface, QueryRunner } from 'typeorm';
export class ServerControl1789880000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    // Permissions and grants already exist since AuthRbac; only the operation log is new.
    await queryRunner.query(`
      CREATE TABLE server_control_operations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        type varchar(32) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING',
        idempotency_key varchar(128) NOT NULL,
        correlation_id uuid NOT NULL,
        request_id varchar(128),
        requested_by_staff_id uuid NOT NULL,
        dispatch_claimed_at timestamptz,
        dispatched_at timestamptz,
        completed_at timestamptz,
        error_code varchar(64),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT server_control_operations_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT server_control_operations_staff_fkey FOREIGN KEY (requested_by_staff_id) REFERENCES staff_users(id),
        CONSTRAINT server_control_operations_idempotency_key UNIQUE (game_server_id, idempotency_key),
        CONSTRAINT server_control_operations_correlation_key UNIQUE (correlation_id),
        CONSTRAINT server_control_operations_type_check CHECK (type IN ('SERVER_START', 'SERVER_PAUSE', 'SERVER_RESTART')),
        CONSTRAINT server_control_operations_status_check CHECK (status IN ('PENDING', 'DISPATCHED', 'SUCCEEDED', 'FAILED')),
        CONSTRAINT server_control_operations_pending_check CHECK (status <> 'PENDING' OR (dispatched_at IS NULL AND completed_at IS NULL)),
        CONSTRAINT server_control_operations_dispatched_check CHECK (status NOT IN ('DISPATCHED', 'SUCCEEDED') OR dispatched_at IS NOT NULL),
        CONSTRAINT server_control_operations_completed_check CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (completed_at IS NOT NULL)),
        CONSTRAINT server_control_operations_error_check CHECK ((status = 'FAILED') = (error_code IS NOT NULL))
      );
      CREATE INDEX server_control_operations_dispatch_idx ON server_control_operations(status, created_at);
      CREATE INDEX server_control_operations_server_idx ON server_control_operations(game_server_id, created_at);
      CREATE INDEX server_control_operations_request_idx ON server_control_operations(request_id);
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE server_control_operations;`);
  }
}
