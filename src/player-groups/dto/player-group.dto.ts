import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsUUID } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import {
  GroupInviteStatus,
  GroupRole,
  GroupStatus,
  MAX_GROUP_MEMBERS,
} from '../player-group.contracts.js';

export class GroupRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() groupId: string;
}
export class GroupMemberRouteDto extends GroupRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() memberId: string;
}
export class GroupInviteRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() inviteId: string;
}
export class GroupCharacterBodyDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
export class GroupInviteBodyDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Your VERIFIED character link that leads the group.',
  })
  @IsUUID()
  actorCharacterLinkId: string;
  // Public, server-scoped game id of the target; the server comes from the
  // group. Ownership UUIDs of other players are never accepted or exposed.
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description:
      'In-game character id of the target on the group server. Knowing it grants no ownership.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  targetCharacterId: string;
}
export class EmptyGroupBodyDto {}
export class GroupMemberDto {
  @ApiProperty({ format: 'uuid' }) memberId: string;
  @ApiProperty() characterId: string;
  @ApiProperty({ enum: GroupRole }) role: GroupRole;
  @ApiProperty({ format: 'date-time' }) joinedAt: Date;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Only for your own characters; null for other players.',
  })
  characterLinkId: string | null;
}
export class GroupDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({ enum: GroupStatus }) status: GroupStatus;
  @ApiProperty({ example: MAX_GROUP_MEMBERS }) maxMembers: number;
  @ApiProperty({ type: GroupMemberDto, isArray: true })
  members: GroupMemberDto[];
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
export class GroupInviteDto {
  @ApiProperty({ format: 'uuid' }) inviteId: string;
  @ApiProperty({ format: 'uuid' }) groupId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty() targetCharacterId: string;
  @ApiProperty() invitedByCharacterId: string;
  @ApiProperty({ enum: GroupInviteStatus }) status: GroupInviteStatus;
  @ApiProperty({ format: 'date-time' }) expiresAt: Date;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt: Date | null;
}
export class GroupInviteListDto {
  @ApiProperty({ type: GroupInviteDto, isArray: true })
  items: GroupInviteDto[];
}
