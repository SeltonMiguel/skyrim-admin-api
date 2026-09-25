import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { PageQueryDto } from '../../admin-queries/dto/query.dto.js';
import {
  Currency,
  EconomyTransactionType,
  EntryDirection,
  MAX_CHARACTER_BALANCE,
} from '../economy.contracts.js';

export class WalletRouteDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
// Only page and limit: the character comes from the route.
export class WalletTransactionsQueryDto extends PageQueryDto {}
export class WalletDto {
  @ApiProperty({ format: 'uuid' }) characterLinkId: string;
  @ApiProperty({ enum: Currency }) currency: Currency;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_CHARACTER_BALANCE,
    description: 'Integer units; 0 when the character has no ledger yet.',
  })
  balance: number;
}
export class WalletTransactionDto {
  @ApiProperty({ format: 'uuid' }) transactionId: string;
  @ApiProperty({ enum: EconomyTransactionType }) type: EconomyTransactionType;
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: 'Positive magnitude for this character.',
  })
  amount: number;
  @ApiProperty({ enum: EntryDirection }) direction: EntryDirection;
  @ApiProperty({ type: String, nullable: true }) referenceType: string | null;
  @ApiProperty({ type: String, nullable: true }) referenceId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
export class WalletTransactionPageDto {
  @ApiProperty({ type: WalletTransactionDto, isArray: true })
  items: WalletTransactionDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
