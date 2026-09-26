import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

// Shared fixed-window counter (12.5, MULTI): one row per (scope, SHA-256 of
// the key). The key itself (IP, username, session...) is never stored.
@Entity('rate_limit_buckets')
@Index('rate_limit_buckets_expiry_idx', ['expiresAt'])
@Check(
  'rate_limit_buckets_check',
  `length(scope) > 0 AND key_hash ~ '^[0-9a-f]{64}$' AND hits >= 0 AND expires_at > window_started_at`,
)
export class RateLimitBucket {
  @PrimaryColumn({
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'rate_limit_buckets_pkey',
  })
  scope: string;
  @PrimaryColumn({
    name: 'key_hash',
    type: 'char',
    length: 64,
    primaryKeyConstraintName: 'rate_limit_buckets_pkey',
  })
  keyHash: string;
  @Column({ type: 'integer' })
  hits: number;
  @Column({ name: 'window_started_at', type: 'timestamptz' })
  windowStartedAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
