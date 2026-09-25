import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, IsUUID, Max, Min } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import {
  CHAT_PAGE_DEFAULT_LIMIT,
  ChatChannel,
  chatMessage,
  MAX_CHAT_MESSAGE_LENGTH,
} from '../player-chat.contracts.js';

export class ChatCharacterRouteDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
export class ChatGroupRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() groupId: string;
}
export class ChatGuildRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() guildId: string;
}
// Public, server-scoped game id; the server comes from your own character.
export class ChatTargetRouteDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description:
      'In-game character id of the other participant on your server. Knowing it grants no ownership.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  targetCharacterId: string;
}
export class ChatDirectHistoryRouteDto extends ChatCharacterRouteDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  targetCharacterId: string;
}
export class SendChatBodyDto extends ChatCharacterRouteDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_CHAT_MESSAGE_LENGTH,
    description:
      'Plain text, trimmed, 1–500 Unicode code points, one line. HTML or Markdown is stored and returned as literal text; clients must escape it.',
  })
  @Transform(({ value }: { value: unknown }) => chatMessage(value))
  @IsString()
  message: string;
}
export class ChatPageQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;
  @ApiPropertyOptional({
    default: CHAT_PAGE_DEFAULT_LIMIT,
    minimum: 1,
    maximum: 100,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = CHAT_PAGE_DEFAULT_LIMIT;
}
export class ChatChannelPageQueryDto extends ChatPageQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Your VERIFIED character link.' })
  @IsUUID()
  characterLinkId: string;
}
export class ChatMessageDto {
  @ApiProperty({ format: 'uuid' }) messageId: string;
  @ApiProperty({ enum: ChatChannel }) channelType: ChatChannel;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({ description: 'In-game character id of the sender.' })
  senderCharacterId: string;
  @ApiProperty({ description: 'Plain text; render escaped.' })
  message: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  groupId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  guildId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DIRECT only: in-game character id of the recipient.',
  })
  targetCharacterId: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
export class ChatMessagePageDto {
  @ApiProperty({ type: ChatMessageDto, isArray: true }) items: ChatMessageDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
