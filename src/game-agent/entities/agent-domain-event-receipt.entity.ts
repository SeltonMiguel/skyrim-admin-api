import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type {
  AgentEventKind,
  ReceiptStatus,
} from '../agent-domain-event.contracts.js';

// Durable delivery identity of a Host Agent DOMAIN_EVENT (Etapa 11.4):
// (server of the authenticated session, eventId). Written in the domain
// transaction for accepted events, alone for final rejections. Holds only
// the kind and a SHA-256 of the canonical content, never the payload (an
// ownership proof must not be stored). Not an Audit record.
@Entity('agent_domain_event_receipts')
@Check(
  'agent_domain_event_receipts_kind_check',
  `kind IN ('CHARACTER_OWNERSHIP_PROOF', 'PROFESSION_EXPERIENCE', 'TRADE_SETTLEMENT', 'MARKETPLACE_CUSTODY', 'MARKETPLACE_SETTLEMENT', 'MARKETPLACE_RELEASE')`,
)
@Check(
  'agent_domain_event_receipts_hash_check',
  `content_hash ~ '^[0-9a-f]{64}$'`,
)
@Check(
  'agent_domain_event_receipts_status_check',
  `(status = 'APPLIED' AND reason IS NULL) OR (status = 'REJECTED' AND reason IS NOT NULL)`,
)
export class AgentDomainEventReceipt {
  @PrimaryColumn({
    name: 'game_server_id',
    type: 'uuid',
    primaryKeyConstraintName: 'agent_domain_event_receipts_pkey',
  })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'agent_domain_event_receipts_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @PrimaryColumn({
    name: 'event_id',
    type: 'uuid',
    primaryKeyConstraintName: 'agent_domain_event_receipts_pkey',
  })
  eventId: string;
  @Column({ type: 'varchar', length: 48 })
  kind: AgentEventKind;
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash: string;
  @Column({ type: 'varchar', length: 16 })
  status: ReceiptStatus;
  // Final domain rejection reason (closed catalogs of the domains).
  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
