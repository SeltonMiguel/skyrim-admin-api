import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '../../rbac/roles.js';
import { AuditAction, AuditOutcome } from '../audit.types.js';
import { ActorType, SystemSource } from '../../actors/actor.contracts.js';

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ActorType,
    nullable: true,
    description:
      'Historical rows without a stored type are STAFF when actorStaffId is set; null means no actor.',
  })
  actorType: ActorType | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorStaffId: string | null;
  @ApiProperty({ type: String, nullable: true })
  actorUsername: string | null;
  @ApiProperty({ type: String, nullable: true })
  actorDisplayName: string | null;
  @ApiProperty({
    enum: RoleName,
    nullable: true,
    description: 'Staff only; always null for PLAYER and SYSTEM.',
  })
  actorRole: RoleName | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorPlayerId: string | null;
  @ApiProperty({ enum: SystemSource, nullable: true })
  actorSystemSource: SystemSource | null;
  @ApiProperty({ enum: AuditAction })
  action: AuditAction;
  @ApiProperty({ enum: AuditOutcome })
  outcome: AuditOutcome;
  @ApiProperty({ type: String, nullable: true })
  resourceType: string | null;
  @ApiProperty({ type: String, nullable: true })
  resourceId: string | null;
  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;
  @ApiProperty({ type: String, nullable: true })
  method: string | null;
  @ApiProperty({ type: String, nullable: true })
  path: string | null;
  @ApiProperty({ type: Number, nullable: true })
  statusCode: number | null;
  @ApiProperty({ type: String, nullable: true })
  ipAddress: string | null;
  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  metadata: object | null;
  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class AuditPageDto {
  @ApiProperty({ type: AuditLogDto, isArray: true })
  items: AuditLogDto[];
  @ApiProperty()
  total: number;
  @ApiProperty()
  page: number;
  @ApiProperty()
  limit: number;
  @ApiProperty()
  totalPages: number;
}
