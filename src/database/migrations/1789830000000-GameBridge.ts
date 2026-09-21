import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GameBridge1789830000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE game_servers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(64) NOT NULL,
        name varchar(100) NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT game_servers_code_key UNIQUE (code)
      );
      CREATE TABLE game_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL,
        external_connection_id varchar(128) NOT NULL,
        status varchar(16) NOT NULL,
        bridge_version varchar(64), protocol_version varchar(16),
        connected_at timestamptz NOT NULL,
        last_heartbeat_at timestamptz NOT NULL,
        disconnected_at timestamptz,
        disconnect_reason varchar(32),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT game_connections_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT game_connections_external_key UNIQUE (game_server_id, external_connection_id),
        CONSTRAINT game_connections_status_check CHECK (status IN ('CONNECTED', 'DISCONNECTED')),
        CONSTRAINT game_connections_closed_check CHECK ((status = 'CONNECTED' AND disconnected_at IS NULL AND disconnect_reason IS NULL) OR (status = 'DISCONNECTED' AND disconnected_at IS NOT NULL AND disconnect_reason IS NOT NULL))
      );
      CREATE UNIQUE INDEX game_connections_active_key ON game_connections(game_server_id) WHERE status = 'CONNECTED';
      CREATE INDEX game_connections_heartbeat_idx ON game_connections(status, last_heartbeat_at);
      CREATE TABLE game_commands (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_server_id uuid NOT NULL, type varchar(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING', payload jsonb NOT NULL,
        idempotency_key varchar(128) NOT NULL, correlation_id uuid NOT NULL,
        request_id varchar(128), requested_by_staff_id uuid,
        dispatched_connection_id uuid,
        dispatch_attempts integer NOT NULL DEFAULT 0,
        last_dispatch_at timestamptz, acknowledged_at timestamptz,
        completed_at timestamptz, ack_deadline_at timestamptz,
        execution_deadline_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT game_commands_server_fkey FOREIGN KEY (game_server_id) REFERENCES game_servers(id),
        CONSTRAINT game_commands_staff_fkey FOREIGN KEY (requested_by_staff_id) REFERENCES staff_users(id),
        CONSTRAINT game_commands_connection_fkey FOREIGN KEY (dispatched_connection_id) REFERENCES game_connections(id),
        CONSTRAINT game_commands_idempotency_key UNIQUE (game_server_id, idempotency_key),
        CONSTRAINT game_commands_correlation_key UNIQUE (correlation_id),
        CONSTRAINT game_commands_status_check CHECK (status IN ('PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'SUCCEEDED', 'FAILED', 'TIMEOUT')),
        CONSTRAINT game_commands_attempts_check CHECK (dispatch_attempts >= 0),
        CONSTRAINT game_commands_payload_check CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
        CONSTRAINT game_commands_completed_check CHECK ((status IN ('SUCCEEDED', 'FAILED', 'TIMEOUT')) = (completed_at IS NOT NULL))
      );
      CREATE INDEX game_commands_dispatch_idx ON game_commands(status, ack_deadline_at, created_at);
      CREATE INDEX game_commands_execution_idx ON game_commands(status, execution_deadline_at);
      CREATE INDEX game_commands_server_idx ON game_commands(game_server_id, status);
      CREATE INDEX game_commands_request_idx ON game_commands(request_id);
      CREATE INDEX game_commands_connection_idx ON game_commands(dispatched_connection_id);
      CREATE TABLE game_command_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        game_command_id uuid NOT NULL, outcome varchar(16) NOT NULL,
        result jsonb, error_code varchar(64), error_message varchar(256),
        received_at timestamptz NOT NULL,
        CONSTRAINT game_command_results_command_fkey FOREIGN KEY (game_command_id) REFERENCES game_commands(id),
        CONSTRAINT game_command_results_command_key UNIQUE (game_command_id),
        CONSTRAINT game_command_results_outcome_check CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'TIMEOUT')),
        CONSTRAINT game_command_results_size_check CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096))
      );
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE game_command_results;
      DROP TABLE game_commands;
      DROP TABLE game_connections;
      DROP TABLE game_servers;
    `);
  }
}
