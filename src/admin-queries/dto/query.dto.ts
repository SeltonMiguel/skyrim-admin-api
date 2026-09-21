import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
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
import { CommandStatus } from '../../game-bridge/command-state.js';
import type { CommandType } from '../../game-bridge/command-contract.js';
import { ServerHealth } from '../server-health.js';

export class EmptyQueryDto {}

export class PageQueryDto {
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
}

export class DatePageQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Inclusive lower bound, ISO 8601 with timezone; must not exceed to.',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @MaxLength(35)
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Inclusive upper bound, ISO 8601 with timezone; must not precede from.',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @MaxLength(35)
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;
}

export class ServerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ maxLength: 64, description: 'Exact server code.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  code?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    enum: ServerHealth,
    description: 'Derived at query time; never updates connection state.',
  })
  @IsOptional()
  @IsEnum(ServerHealth)
  health?: ServerHealth;
}

export class ConnectionQueryDto extends DatePageQueryDto {
  @ApiPropertyOptional({ enum: ['CONNECTED', 'DISCONNECTED'] })
  @IsOptional()
  @IsIn(['CONNECTED', 'DISCONNECTED'])
  status?: 'CONNECTED' | 'DISCONNECTED';
}

export class CommandQueryDto extends DatePageQueryDto {
  @ApiPropertyOptional({ enum: CommandStatus })
  @IsOptional()
  @IsEnum(CommandStatus)
  status?: CommandStatus;

  @ApiPropertyOptional({ enum: ['BRIDGE_PING'] })
  @IsOptional()
  @IsIn(['BRIDGE_PING'])
  type?: CommandType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  requestedByStaffId?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  requestId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
