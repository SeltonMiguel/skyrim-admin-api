import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsInt,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../admin-queries/dto/query.dto.js';
import { externalId } from '../../game-bridge/command-validation.js';
import { MAX_CHARACTER_BALANCE } from '../../economy/economy.contracts.js';
import {
  MAX_TRADE_ITEM_LINES,
  MAX_TRADE_ITEM_QUANTITY,
  TradeStatus,
} from '../player-trade.contracts.js';

export class TradeRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() tradeId: string;
}
export class TradeCharacterRouteDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
// Same shape as a query or a body: the own link the player acts through.
export class TradeCharacterDto extends TradeCharacterRouteDto {}
export class TradeListQueryDto extends PageQueryDto {}
export class TradeItemDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: 'Opaque game item id; a declaration, not proof of custody.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  itemId: string;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    maximum: MAX_TRADE_ITEM_QUANTITY,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TRADE_ITEM_QUANTITY)
  quantity: number;
}
export class TradeOfferDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_CHARACTER_BALANCE,
    description: 'Backend GOLD (ledger), integer units.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_CHARACTER_BALANCE)
  gold: number;
  @ApiProperty({
    type: TradeItemDto,
    isArray: true,
    maxItems: MAX_TRADE_ITEM_LINES,
    description: 'Distinct item ids.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_TRADE_ITEM_LINES)
  @ValidateNested({ each: true })
  @Type(() => TradeItemDto)
  items: TradeItemDto[];
}
export class CreateTradeBodyDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  actorCharacterLinkId: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description:
      'In-game character id of the counterparty on the same server. Knowing it grants no ownership.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  targetCharacterId: string;
  @ApiProperty({ type: TradeOfferDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => TradeOfferDto)
  offer: TradeOfferDto;
}
export class UpdateTradeOfferBodyDto extends TradeOfferDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
// The initiator confirms the TARGET offer version and the target confirms
// the INITIATOR offer version: nobody accepts a changed offer unseen.
export class AcceptTradeBodyDto extends TradeCharacterRouteDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description:
      "Current version of the COUNTERPARTY's offer you are accepting (not your own); a changed offer returns 409.",
  })
  @IsInt()
  @Min(1)
  counterpartyOfferVersion: number;
}
export class TradeServerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
}
export class TradeOfferViewDto {
  @ApiProperty({ type: 'integer', minimum: 1 }) version: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) gold: number;
  @ApiProperty({ type: TradeItemDto, isArray: true }) items: TradeItemDto[];
}
export class TradePartyDto {
  @ApiProperty({ description: 'In-game character id (characterExternalId).' })
  characterId: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Only for your own characters; null for other players.',
  })
  characterLinkId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt: Date | null;
  @ApiProperty({ type: TradeOfferViewDto }) offer: TradeOfferViewDto;
}
export class TradeDto {
  @ApiProperty({ format: 'uuid' }) tradeId: string;
  @ApiProperty({ type: TradeServerDto }) gameServer: TradeServerDto;
  @ApiProperty({ enum: TradeStatus }) status: TradeStatus;
  @ApiProperty({ type: TradePartyDto }) initiator: TradePartyDto;
  @ApiProperty({ type: TradePartyDto }) target: TradePartyDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lockedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  failedAt: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}
export class TradePageDto {
  @ApiProperty({ type: TradeDto, isArray: true }) items: TradeDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
