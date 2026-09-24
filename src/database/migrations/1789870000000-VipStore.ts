import type { MigrationInterface, QueryRunner } from 'typeorm';
export class VipStore1789870000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE vip_offers (
        id uuid NOT NULL DEFAULT uuid_generate_v4(),
        code varchar(64) NOT NULL,
        name varchar(100) NOT NULL,
        description varchar(2000) NOT NULL,
        price_minor integer NOT NULL,
        currency varchar(3) NOT NULL,
        active boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0,
        rewards jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vip_offers_pkey PRIMARY KEY (id),
        CONSTRAINT vip_offers_code_key UNIQUE (code),
        CONSTRAINT vip_offers_code_check CHECK (code ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
        CONSTRAINT vip_offers_name_check CHECK (length(btrim(name)) > 0),
        CONSTRAINT vip_offers_price_check CHECK (price_minor >= 0),
        CONSTRAINT vip_offers_currency_check CHECK (currency = 'BRL'),
        CONSTRAINT vip_offers_sort_order_check CHECK (sort_order BETWEEN 0 AND 1000000),
        CONSTRAINT vip_offers_rewards_check CHECK (CASE WHEN jsonb_typeof(rewards) = 'array' THEN jsonb_array_length(rewards) BETWEEN 1 AND 20 AND octet_length(rewards::text) <= 32768 ELSE false END)
      );
      CREATE INDEX vip_offers_catalog_idx ON vip_offers(active,sort_order,code);
      INSERT INTO permissions(name) VALUES ('VIP_STORE_READ');
      INSERT INTO role_permissions(role_name,permission_name) VALUES ('COORDINATOR','VIP_STORE_READ');
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM role_permissions WHERE permission_name='VIP_STORE_READ';
      DELETE FROM permissions WHERE name='VIP_STORE_READ';
      DROP TABLE vip_offers;
    `);
  }
}
