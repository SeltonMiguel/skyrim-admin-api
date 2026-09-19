import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditAction, AuditOutcome, AuditResource } from '../audit.types.js';

export class AuditQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorStaffId?: string;

  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({ enum: AuditOutcome })
  @IsOptional()
  @IsEnum(AuditOutcome)
  outcome?: AuditOutcome;

  @ApiPropertyOptional({ enum: AuditResource })
  @IsOptional()
  @IsEnum(AuditResource)
  resourceType?: AuditResource;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  resourceId?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  requestId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Inclusive lower bound, ISO 8601 with timezone',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @MaxLength(35)
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Inclusive upper bound, ISO 8601 with timezone',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @MaxLength(35)
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;
}
