import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

// One authenticated realtime socket somewhere in the cluster (12.5, MULTI):
// the per-principal connection cap counts these. No token is stored.
// Renewed in one batch per instance; a crashed instance's leases expire.
@Entity('realtime_connection_leases')
@Index('realtime_connection_leases_principal_idx', [
  'surface',
  'principalId',
  'expiresAt',
])
@Index('realtime_connection_leases_instance_idx', ['instanceId'])
@Index('realtime_connection_leases_expiry_idx', ['expiresAt'])
@Check(
  'realtime_connection_leases_check',
  `surface IN ('PLAYER', 'STAFF') AND expires_at > connected_at`,
)
export class RealtimeConnectionLease {
  @PrimaryColumn({ type: 'uuid' })
  id: string;
  @Column({ type: 'varchar', length: 8 })
  surface: 'PLAYER' | 'STAFF';
  @Column({ name: 'principal_id', type: 'uuid' })
  principalId: string;
  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId: string | null;
  @Column({ name: 'instance_id', type: 'uuid' })
  instanceId: string;
  @Column({
    name: 'connected_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  connectedAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;
}
