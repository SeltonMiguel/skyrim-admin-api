import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../admin-queries/dto/query.dto.js';
import {
  EntryDirection,
  MAX_TRANSACTION_AMOUNT,
} from '../../economy/economy.contracts.js';
import { AGENT_EVENT_KINDS } from '../../game-agent/agent-domain-event.contracts.js';
import type { AgentEventKind } from '../../game-agent/agent-domain-event.contracts.js';
import { PlayerStatus } from '../../player-accounts/player-account.contracts.js';
import { ReleaseResolution } from '../../player-marketplace/player-marketplace.contracts.js';
import { SERVER_CONTROL_RESOLUTIONS } from '../../server-control/server-control.contracts.js';
import type { ServerControlResolution } from '../../server-control/server-control.contracts.js';
import {
  DeliveryResolution,
  DeliveryStatus,
} from '../../vip-entitlements/vip-delivery.contracts.js';
import { MAX_REASON_LENGTH } from '../operations.contracts.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const bool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
// One line of plain text: no control characters.
// eslint-disable-next-line no-control-regex
const PLAIN = /^[^\u0000-\u001f\u007f-\u009f]+$/u;

// Every operator mutation carries a reason: bounded operator text stored
// in operator_actions and the Audit metadata, never shown to Players.
export class ReasonDto {
  @ApiProperty({ minLength: 1, maxLength: MAX_REASON_LENGTH })
  @Transform(trim)
  @IsString()
  @Length(1, MAX_REASON_LENGTH)
  @Matches(PLAIN, { message: 'reason must be one line of plain text' })
  reason: string;
}
export class ResolveServerControlDto extends ReasonDto {
  @ApiProperty({ enum: SERVER_CONTROL_RESOLUTIONS })
  @IsIn(SERVER_CONTROL_RESOLUTIONS)
  resolution: ServerControlResolution;
}
export class ResolveReleaseDto extends ReasonDto {
  @ApiProperty({ enum: ReleaseResolution })
  @IsEnum(ReleaseResolution)
  resolution: ReleaseResolution;
}
export class ResolveDeliveryDto extends ReasonDto {
  @ApiProperty({ enum: DeliveryResolution })
  @IsEnum(DeliveryResolution)
  resolution: DeliveryResolution;
}
export class PlayerStatusDto extends ReasonDto {
  @ApiProperty({ enum: PlayerStatus })
  @IsEnum(PlayerStatus)
  status: PlayerStatus;
}
export class WalletAdjustmentDto extends ReasonDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() gameServerId: string;
  @ApiProperty({ maxLength: 128 })
  @Transform(trim)
  @IsString()
  @Length(1, 128)
  @Matches(PLAIN)
  characterExternalId: string;
  @ApiProperty({ enum: EntryDirection })
  @IsEnum(EntryDirection)
  direction: EntryDirection;
  @ApiProperty({ minimum: 1, maximum: MAX_TRANSACTION_AMOUNT })
  @IsInt()
  @Min(1)
  @Max(MAX_TRANSACTION_AMOUNT)
  amount: number;
  // Ticket / case identifier, stored as the ledger reference id.
  @ApiProperty({ pattern: '^[A-Za-z0-9._:-]{1,64}$' })
  @IsString()
  @Matches(/^[A-Za-z0-9._:-]{1,64}$/)
  externalReference: string;
}

export class WorkQueueQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gameServerId?: string;
}
export class ServerControlQueueQueryDto extends WorkQueueQueryDto {
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  resolved?: boolean;
}
export class ReleaseQueueQueryDto extends ServerControlQueueQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'FAILED'] })
  @IsOptional()
  @IsIn(['PENDING', 'FAILED'])
  status?: 'PENDING' | 'FAILED';
}
export class VipQueueQueryDto extends ServerControlQueueQueryDto {
  @ApiPropertyOptional({ enum: DeliveryStatus })
  @IsOptional()
  @IsEnum(DeliveryStatus)
  status?: DeliveryStatus;
}
export class ReceiptQueryDto extends WorkQueueQueryDto {
  @ApiPropertyOptional({ enum: AGENT_EVENT_KINDS })
  @IsOptional()
  @IsIn(AGENT_EVENT_KINDS)
  kind?: AgentEventKind;
}
export class ChatQueryDto extends PageQueryDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() gameServerId: string;
  @ApiPropertyOptional({ enum: ['GLOBAL', 'GROUP', 'GUILD'] })
  @IsOptional()
  @IsIn(['GLOBAL', 'GROUP', 'GUILD'])
  channel?: 'GLOBAL' | 'GROUP' | 'GUILD';
  @ApiPropertyOptional({ maxLength: 128 })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  senderCharacterId?: string;
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  hidden?: boolean;
}
export class WalletRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() gameServerId: string;
  @ApiProperty({ maxLength: 128 })
  @IsString()
  @Length(1, 128)
  characterExternalId: string;
}
