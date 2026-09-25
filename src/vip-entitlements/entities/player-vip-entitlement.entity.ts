import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Relation } from 'typeorm';
import { GameServer } from '../../game-bridge/entities/game-server.entity.js';
import { Player } from '../../player-accounts/entities/player.entity.js';
import { VipOffer } from '../../vip-store/entities/vip-offer.entity.js';
import type {
  EntitlementStatus,
  VipEntitlementScope,
} from '../vip-entitlement.contracts.js';

// A right to a VIP offer held by an account (PLAYER) or a character identity
// (CHARACTER: server + external id, never an ownership link). One ACTIVE
// row per equivalent holder; revoked/expired rows stay as history. Effective
// = ACTIVE and not past expires_at (expiry is lazy).
@Entity('player_vip_entitlements')
@Index(
  'player_vip_entitlements_player_active_key',
  ['vipOfferId', 'playerId'],
  { unique: true, where: `status = 'ACTIVE' AND scope = 'PLAYER'` },
)
@Index(
  'player_vip_entitlements_character_active_key',
  ['vipOfferId', 'gameServerId', 'characterExternalId'],
  { unique: true, where: `status = 'ACTIVE' AND scope = 'CHARACTER'` },
)
@Index('player_vip_entitlements_player_idx', ['playerId', 'status'])
@Index('player_vip_entitlements_character_idx', [
  'gameServerId',
  'characterExternalId',
  'status',
])
@Check(
  'player_vip_entitlements_scope_check',
  `(scope = 'PLAYER' AND player_id IS NOT NULL AND game_server_id IS NULL AND character_external_id IS NULL) OR (scope = 'CHARACTER' AND player_id IS NULL AND game_server_id IS NOT NULL AND character_external_id IS NOT NULL AND length(btrim(character_external_id)) > 0)`,
)
@Check(
  'player_vip_entitlements_status_check',
  `(status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL) OR (status = 'EXPIRED' AND expires_at IS NOT NULL AND revoked_at IS NULL)`,
)
@Check(
  'player_vip_entitlements_expiry_check',
  `expires_at IS NULL OR expires_at > granted_at`,
)
@Check(
  'player_vip_entitlements_source_check',
  `source ~ '^(STAFF|SYSTEM:[A-Z_]{1,32})$' AND (external_reference IS NULL OR length(btrim(external_reference)) > 0)`,
)
export class PlayerVipEntitlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;
  @Column({ name: 'vip_offer_id', type: 'uuid' })
  vipOfferId: string;
  @ManyToOne(() => VipOffer)
  @JoinColumn({
    name: 'vip_offer_id',
    foreignKeyConstraintName: 'player_vip_entitlements_offer_fkey',
  })
  offer: Relation<VipOffer>;
  @Column({ type: 'varchar', length: 16 })
  scope: VipEntitlementScope;
  @Column({ name: 'player_id', type: 'uuid', nullable: true })
  playerId: string | null;
  @ManyToOne(() => Player)
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'player_vip_entitlements_player_fkey',
  })
  player: Relation<Player>;
  @Column({ name: 'game_server_id', type: 'uuid', nullable: true })
  gameServerId: string | null;
  @ManyToOne(() => GameServer)
  @JoinColumn({
    name: 'game_server_id',
    foreignKeyConstraintName: 'player_vip_entitlements_server_fkey',
  })
  gameServer: Relation<GameServer>;
  @Column({
    name: 'character_external_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  characterExternalId: string | null;
  @Column({ type: 'varchar', length: 16, default: 'ACTIVE' })
  status: EntitlementStatus;
  @Column({ name: 'granted_at', type: 'timestamptz' })
  grantedAt: Date;
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
  // Internal: STAFF or SYSTEM:<source> that granted it; never exposed.
  @Column({ type: 'varchar', length: 64 })
  source: string;
  @Column({
    name: 'external_reference',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  externalReference: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
