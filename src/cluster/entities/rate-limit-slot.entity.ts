import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

// Keyed sliding-window slot (12.5, MULTI): the chat anti-spam window, where
// one slot belongs to one Idempotency-Key (retries never consume quota).
// Bucket and slot keys are SHA-256 hashes.
@Entity('rate_limit_slots')
@Index('rate_limit_slots_expiry_idx', ['expiresAt'])
@Check(
  'rate_limit_slots_check',
  `length(scope) > 0 AND key_hash ~ '^[0-9a-f]{64}$' AND slot_hash ~ '^[0-9a-f]{64}$' AND expires_at > created_at`,
)
export class RateLimitSlot {
  @PrimaryColumn({
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'rate_limit_slots_pkey',
  })
  scope: string;
  @PrimaryColumn({
    name: 'key_hash',
    type: 'char',
    length: 64,
    primaryKeyConstraintName: 'rate_limit_slots_pkey',
  })
  keyHash: string;
  @PrimaryColumn({
    name: 'slot_hash',
    type: 'char',
    length: 64,
    primaryKeyConstraintName: 'rate_limit_slots_pkey',
  })
  slotHash: string;
  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
