import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  getSchemaPath,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  MAX_PRICE_MINOR,
  MAX_REWARDS,
  offerCode,
  offerText,
  vipRewards,
} from '../vip-offer.contracts.js';
import { VipEntitlementScope } from '../vip-offer.contracts.js';
import type { VipCurrency, VipReward } from '../vip-offer.contracts.js';
export class VipItemRewardDto {
  @ApiProperty({ enum: ['ITEM'] }) type: 'ITEM';
  @ApiProperty({ minLength: 1, maxLength: 128 }) itemId: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 10000 })
  quantity: number;
}
export class VipHorseRewardDto {
  @ApiProperty({ enum: ['HORSE'] }) type: 'HORSE';
  @ApiProperty({ minLength: 1, maxLength: 128 }) horseId: string;
}
export class VipTitleRewardDto {
  @ApiProperty({ enum: ['TITLE'] }) type: 'TITLE';
  @ApiProperty({ minLength: 1, maxLength: 128 }) titleId: string;
}
export class VipSpellRewardDto {
  @ApiProperty({ enum: ['SPELL'] }) type: 'SPELL';
  @ApiProperty({ minLength: 1, maxLength: 128 }) spellId: string;
}
const rewardModels = [
  VipItemRewardDto,
  VipHorseRewardDto,
  VipTitleRewardDto,
  VipSpellRewardDto,
];
const rewardSchema = {
  type: 'array' as const,
  minItems: 1,
  maxItems: MAX_REWARDS,
  items: {
    oneOf: rewardModels.map((type) => ({ $ref: getSchemaPath(type) })),
    discriminator: { propertyName: 'type' },
  },
};
@ApiExtraModels(...rewardModels)
export class OfferContentDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) => offerText(value, 100))
  @IsString()
  name: string;
  @ApiProperty({
    maxLength: 2000,
    description: 'Plain text; LF allowed. Empty description is allowed.',
  })
  @Transform(({ value }: { value: unknown }) => offerText(value, 2000, true))
  @IsString()
  description: string;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PRICE_MINOR,
    description:
      'BRL centavos; 1990 means R$19.90. Never a floating point monetary amount.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_PRICE_MINOR)
  priceMinor: number;
  @ApiProperty({ enum: ['BRL'] }) @IsIn(['BRL']) currency: VipCurrency;
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: 1000000,
    default: 0,
  })
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(1000000)
  sortOrder?: number;
  @ApiProperty(rewardSchema)
  @Transform(({ value }: { value: unknown }) => vipRewards(value))
  @IsArray()
  rewards: VipReward[];
  @ApiPropertyOptional({
    enum: VipEntitlementScope,
    default: VipEntitlementScope.CHARACTER,
    description:
      'Who holds the entitlement: the account (PLAYER) or one character identity (CHARACTER). Applies to new grants only.',
  })
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsIn(Object.values(VipEntitlementScope))
  entitlementScope?: VipEntitlementScope;
}
export class CreateVipOfferDto extends OfferContentDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 64,
    pattern: '^[a-z0-9][a-z0-9_-]{2,63}$',
    description: 'Trimmed, lowercase and immutable after creation.',
  })
  @Transform(({ value }: { value: unknown }) => offerCode(value))
  @IsString()
  code: string;
  @ApiPropertyOptional({ default: false })
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}
export class UpdateVipOfferDto extends PartialType(OfferContentDto, {
  skipNullProperties: false,
}) {}
export class VipOfferActiveDto {
  @ApiProperty() @IsBoolean() active: boolean;
}
@ApiExtraModels(...rewardModels)
export class VipOfferPublicDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: MAX_PRICE_MINOR })
  priceMinor: number;
  @ApiProperty({ enum: ['BRL'] }) currency: VipCurrency;
  @ApiProperty(rewardSchema) rewards: VipReward[];
  @ApiProperty({ enum: VipEntitlementScope })
  entitlementScope: VipEntitlementScope;
}
export class VipOfferAdminDto extends VipOfferPublicDto {
  @ApiProperty() active: boolean;
  @ApiProperty({ type: 'integer' }) sortOrder: number;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}
class OfferPageDto {
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
export class VipCatalogPageDto extends OfferPageDto {
  @ApiProperty({ type: VipOfferPublicDto, isArray: true })
  items: VipOfferPublicDto[];
}
export class VipAdminPageDto extends OfferPageDto {
  @ApiProperty({ type: VipOfferAdminDto, isArray: true })
  items: VipOfferAdminDto[];
}
