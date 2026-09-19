import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuditLog1789820000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_staff_id uuid,
        actor_username varchar(64),
        actor_display_name varchar(100),
        actor_role varchar(32),
        action varchar(64) NOT NULL,
        outcome varchar(16) NOT NULL,
        resource_type varchar(64),
        resource_id varchar(128),
        request_id varchar(128),
        method varchar(16),
        path varchar(2048),
        status_code integer,
        ip_address varchar(64),
        user_agent varchar(512),
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT audit_logs_outcome_check CHECK (outcome IN ('SUCCESS', 'FAILURE'))
      );
      CREATE INDEX audit_logs_created_id_idx ON audit_logs(created_at, id);
      CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_staff_id);
      CREATE INDEX audit_logs_action_idx ON audit_logs(action);
      CREATE INDEX audit_logs_outcome_idx ON audit_logs(outcome);
      CREATE INDEX audit_logs_request_idx ON audit_logs(request_id);
      CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id);
      CREATE FUNCTION reject_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = '55000';
      END;
      $$;
      CREATE TRIGGER audit_logs_immutable
        BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_mutation();
      ALTER TABLE audit_logs ENABLE ALWAYS TRIGGER audit_logs_immutable;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER audit_logs_immutable ON audit_logs;
      DROP FUNCTION reject_audit_log_mutation();
      DROP TABLE audit_logs;
    `);
  }
}
