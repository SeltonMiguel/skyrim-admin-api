import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { VipOfferPublicDto } from '../../vip-store/dto/vip-offer.dto.js';
import { VipEntitlementScope } from '../vip-entitlement.contracts.js';

export class VipCharacterRouteDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
export class VipEntitlementDto {
  @ApiProperty({ format: 'uuid' }) entitlementId: string;
  @ApiProperty({
    type: VipOfferPublicDto,
    description:
      'Safe catalog projection, also for offers no longer sold (a granted right does not depend on the public catalog).',
  })
  product: VipOfferPublicDto;
  @ApiProperty({ enum: VipEntitlementScope }) scope: VipEntitlementScope;
  @ApiProperty({ format: 'date-time' }) grantedAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null = permanent.',
  })
  expiresAt: Date | null;
}
export class VipEntitlementListDto {
  @ApiProperty({ type: VipEntitlementDto, isArray: true })
  items: VipEntitlementDto[];
}
// Account and character rights side by side: the scope is never collapsed.
export class VipEffectiveDto {
  @ApiProperty({ type: VipEntitlementDto, isArray: true })
  player: VipEntitlementDto[];
  @ApiProperty({ type: VipEntitlementDto, isArray: true })
  character: VipEntitlementDto[];
}
