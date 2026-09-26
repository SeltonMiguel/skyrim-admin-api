import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// Ephemeral envelope of the PostgreSQL bus (12.5): NOTIFY carries only
// `origin:id`; receivers read the envelope here. Deleted after expires_at
// by a bounded cleanup; never replayed to reconnecting clients.
@Entity('distributed_bus_events')
@Index('distributed_bus_events_expiry_idx', ['expiresAt'])
@Check(
  'distributed_bus_events_check',
  `kind ~ '^[A-Z][A-Z_]{0,47}$' AND jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536 AND expires_at > created_at`,
)
export class DistributedBusEvent {
  @PrimaryColumn({ type: 'uuid' })
  id: string;
  @Column({ type: 'varchar', length: 48 })
  kind: string;
  @Column({ name: 'origin_instance_id', type: 'uuid' })
  originInstanceId: string;
  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
