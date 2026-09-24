import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import {
  GUILD_NAME_MAX_LENGTH,
  GUILD_NAME_MIN_LENGTH,
  GuildInviteStatus,
  GuildRole,
  GuildStatus,
  guildName,
} from '../player-guild.contracts.js';

export class GuildRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() guildId: string;
}
export class GuildMemberRouteDto extends GuildRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() memberId: string;
}
export class GuildInviteRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() inviteId: string;
}
export class GuildCharacterRouteDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
// Same shape as a body or a query: the own link the player acts through.
export class GuildCharacterDto extends GuildCharacterRouteDto {}
export class CreateGuildBodyDto extends GuildCharacterRouteDto {
  @ApiProperty({
    minLength: GUILD_NAME_MIN_LENGTH,
    maxLength: GUILD_NAME_MAX_LENGTH,
    description:
      'Display name, trimmed and kept as typed. Unique per server among active guilds, compared case-insensitively after Unicode NFKC normalization.',
  })
  @Transform(({ value }: { value: unknown }) => guildName(value))
  @IsString()
  name: string;
}
export class GuildActorBodyDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Your VERIFIED character link that is a member of the guild.',
  })
  @IsUUID()
  actorCharacterLinkId: string;
}
export class GuildInviteBodyDto extends GuildActorBodyDto {
  // Public, server-scoped game id of the target; the server comes from the
  // guild. Ownership UUIDs of other players are never accepted or exposed.
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description:
      'In-game character id of the target on the guild server. Knowing it grants no ownership.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  targetCharacterId: string;
}
export const ASSIGNABLE_GUILD_ROLES = [
  GuildRole.OFFICER,
  GuildRole.MEMBER,
] as const;
export class GuildRoleBodyDto extends GuildActorBodyDto {
  @ApiProperty({
    enum: ASSIGNABLE_GUILD_ROLES,
    description: 'MASTER is changed only through transfer-master.',
  })
  @IsIn(ASSIGNABLE_GUILD_ROLES)
  role: GuildRole.OFFICER | GuildRole.MEMBER;
}
export class GuildServerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
}
export class GuildMemberDto {
  @ApiProperty({ format: 'uuid' }) memberId: string;
  @ApiProperty({ description: 'In-game character id (characterExternalId).' })
  characterId: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Only for your own characters; null for other players.',
  })
  characterLinkId: string | null;
  @ApiProperty({ enum: GuildRole }) role: GuildRole;
  @ApiProperty({ format: 'date-time' }) joinedAt: Date;
}
export class GuildDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: GuildServerDto }) gameServer: GuildServerDto;
  @ApiProperty() name: string;
  @ApiProperty({ enum: GuildStatus }) status: GuildStatus;
  @ApiProperty({ type: GuildMemberDto, isArray: true })
  members: GuildMemberDto[];
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
export class CharacterGuildDto {
  @ApiProperty({
    type: GuildDto,
    nullable: true,
    description: 'null when the character is in no active guild.',
  })
  guild: GuildDto | null;
}
export class GuildInviteDto {
  @ApiProperty({ format: 'uuid' }) inviteId: string;
  @ApiProperty({ format: 'uuid' }) guildId: string;
  @ApiProperty() guildName: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty() targetCharacterId: string;
  @ApiProperty() invitedByCharacterId: string;
  @ApiProperty({ enum: GuildInviteStatus }) status: GuildInviteStatus;
  @ApiProperty({ format: 'date-time' }) expiresAt: Date;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt: Date | null;
}
export class GuildInviteListDto {
  @ApiProperty({ type: GuildInviteDto, isArray: true })
  items: GuildInviteDto[];
}
export class GuildLeaveDto {
  @ApiProperty({ format: 'uuid' }) guildId: string;
  @ApiProperty({ format: 'uuid' }) memberId: string;
  @ApiProperty({ format: 'date-time' }) leftAt: Date;
}
export class GuildDisbandDto {
  @ApiProperty({ enum: [GuildStatus.DISBANDED] }) status: GuildStatus;
}
