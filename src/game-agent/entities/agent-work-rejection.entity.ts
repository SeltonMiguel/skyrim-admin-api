import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import type { AgentWorkKind } from '../agent-domain-event.contracts.js';

// Last Agent rejection of an existing work item (12.4), for the operator
// queues: the domain reason and a count, never the event payload. Written
// best-effort after the answer is decided; not a receipt, not an Audit.
@Entity('agent_work_rejections')
@Check(
  'agent_work_rejections_kind_check',
  `kind IN ('TRADE_SETTLEMENT', 'MARKETPLACE_CUSTODY', 'MARKETPLACE_SETTLEMENT', 'MARKETPLACE_RELEASE') AND rejection_count >= 1 AND length(btrim(reason)) > 0`,
)
export class AgentWorkRejection {
  @PrimaryColumn({
    type: 'varchar',
    length: 48,
    primaryKeyConstraintName: 'agent_work_rejections_pkey',
  })
  kind: AgentWorkKind;
  @PrimaryColumn({
    name: 'work_id',
    type: 'uuid',
    primaryKeyConstraintName: 'agent_work_rejections_pkey',
  })
  workId: string;
  @Column({ name: 'game_server_id', type: 'uuid' })
  gameServerId: string;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'agent_work_rejections_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({ type: 'varchar', length: 64 })
  reason: string;
  @Column({ name: 'rejection_count', type: 'integer', default: 1 })
  rejectionCount: number;
  @Column({
    name: 'first_rejected_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  firstRejectedAt: Date;
  @Column({
    name: 'last_rejected_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  lastRejectedAt: Date;
}
