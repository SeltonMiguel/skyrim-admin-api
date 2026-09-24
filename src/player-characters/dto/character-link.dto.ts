import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import { CharacterLinkStatus } from '../player-character.contracts.js';

// The player comes from the token; no playerId, status or challenge input.
export class CreateCharacterLinkDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() gameServerId: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: 'Opaque in-game character id, scoped to the server.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  characterExternalId: string;
}
export class CharacterLinkRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() linkId: string;
}
export class EmptyCharacterLinkBodyDto {}
export class CharacterLinkDto {
  @ApiProperty({ format: 'uuid' }) linkId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty() characterExternalId: string;
  @ApiProperty({ enum: CharacterLinkStatus }) status: CharacterLinkStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}
export class CharacterLinkCreatedDto extends CharacterLinkDto {
  @ApiProperty({
    example: 'ABCD-EFGH-JKMNP',
    description:
      'Shown only in this response; type it in game. Single use; a new request invalidates it.',
  })
  challenge: string;
  @ApiProperty({ format: 'date-time' }) challengeExpiresAt: Date;
}
