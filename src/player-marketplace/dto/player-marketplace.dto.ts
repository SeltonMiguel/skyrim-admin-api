import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { PageQueryDto } from '../../admin-queries/dto/query.dto.js';
import { externalId } from '../../game-bridge/command-validation.js';
import {
  ListingStatus,
  MAX_LISTING_PRICE,
  MAX_LISTING_QUANTITY,
  MIN_LISTING_PRICE,
  PurchaseStatus,
} from '../player-marketplace.contracts.js';

export class ListingRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() listingId: string;
}
export class MarketCharacterRouteDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
// The own link the player acts through (seller or buyer).
export class MarketCharacterDto extends MarketCharacterRouteDto {}
export class CreateListingBodyDto extends MarketCharacterRouteDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description:
      'Opaque game item id; a declaration, not proof of possession. The listing stays PENDING_CUSTODY until the Agent holds the item.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  itemId: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_LISTING_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_LISTING_QUANTITY)
  quantity: number;
  @ApiProperty({
    type: 'integer',
    minimum: MIN_LISTING_PRICE,
    maximum: MAX_LISTING_PRICE,
    description: 'Backend GOLD (ledger), integer units; no free listings.',
  })
  @IsInt()
  @Min(MIN_LISTING_PRICE)
  @Max(MAX_LISTING_PRICE)
  priceGold: number;
}
export class ListingBrowseQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  gameServerId?: string;
  @ApiPropertyOptional({
    type: 'integer',
    minimum: MIN_LISTING_PRICE,
    maximum: MAX_LISTING_PRICE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LISTING_PRICE)
  @Max(MAX_LISTING_PRICE)
  minPrice?: number;
  @ApiPropertyOptional({
    type: 'integer',
    minimum: MIN_LISTING_PRICE,
    maximum: MAX_LISTING_PRICE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LISTING_PRICE)
  @Max(MAX_LISTING_PRICE)
  maxPrice?: number;
}
export class MarketListQueryDto extends PageQueryDto {}
export class MarketServerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
}
export class ListingDto {
  @ApiProperty({ format: 'uuid' }) listingId: string;
  @ApiProperty({ type: MarketServerDto }) gameServer: MarketServerDto;
  @ApiProperty({ description: 'In-game character id of the seller.' })
  sellerCharacterId: string;
  @ApiProperty({ description: 'Opaque game item id.' }) itemId: string;
  @ApiProperty({ type: 'integer' }) quantity: number;
  @ApiProperty({ type: 'integer' }) priceGold: number;
  @ApiProperty({ enum: ListingStatus }) status: ListingStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
// "My listings": the seller's own view, with the own link and lifecycle.
export class OwnListingDto extends ListingDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  characterLinkId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'In-game character id of the buyer once reserved.',
  })
  buyerCharacterId: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reservedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  soldAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  failedAt: Date | null;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}
export class PurchaseDto {
  @ApiProperty({ format: 'uuid' }) purchaseId: string;
  @ApiProperty({ type: ListingDto }) listing: ListingDto;
  @ApiProperty({ description: 'In-game character id of the buyer.' })
  buyerCharacterId: string;
  @ApiProperty({ enum: PurchaseStatus }) status: PurchaseStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  failedAt: Date | null;
}
class PageDto {
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
export class ListingPageDto extends PageDto {
  @ApiProperty({ type: ListingDto, isArray: true }) items: ListingDto[];
}
export class OwnListingPageDto extends PageDto {
  @ApiProperty({ type: OwnListingDto, isArray: true }) items: OwnListingDto[];
}
export class PurchasePageDto extends PageDto {
  @ApiProperty({ type: PurchaseDto, isArray: true }) items: PurchaseDto[];
}
