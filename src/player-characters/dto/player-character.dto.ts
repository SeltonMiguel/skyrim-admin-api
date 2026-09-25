import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { PageQueryDto } from '../../admin-queries/dto/query.dto.js';
import { CharacterLinkStatus } from '../player-character.contracts.js';

// Only page and limit: the player always comes from the token.
export class PlayerCharactersQueryDto extends PageQueryDto {}
export class PlayerCharacterRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() characterLinkId: string;
}
// Registry fields only; no connection health or runtime state.
export class PlayerCharacterServerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({
    description: 'Administrative flag; a disabled server keeps ownership.',
  })
  enabled: boolean;
}
// Identity of an owned character only. Profile/skills come from 10.5 queries.
export class PlayerCharacterDto {
  @ApiProperty({ format: 'uuid', description: 'Character link id.' })
  id: string;
  @ApiProperty({ type: PlayerCharacterServerDto })
  gameServer: PlayerCharacterServerDto;
  @ApiProperty() characterId: string;
  @ApiProperty({
    enum: [CharacterLinkStatus.PENDING, CharacterLinkStatus.VERIFIED],
  })
  status: CharacterLinkStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
export class PlayerCharacterPageDto {
  @ApiProperty({ type: PlayerCharacterDto, isArray: true })
  items: PlayerCharacterDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
