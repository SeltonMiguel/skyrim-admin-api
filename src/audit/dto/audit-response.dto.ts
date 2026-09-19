import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '../../rbac/roles.js';
import { AuditAction, AuditOutcome } from '../audit.types.js';

export class AuditLogDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorStaffId: string | null;
  @ApiProperty({ type: String, nullable: true })
  actorUsername: string | null;
  @ApiProperty({ type: String, nullable: true })
  actorDisplayName: string | null;
  @ApiProperty({ enum: RoleName, nullable: true })
  actorRole: RoleName | null;
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
