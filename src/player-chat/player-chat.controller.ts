import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { ChatRateLimitedException } from './chat-rate-limiter.js';
import { PlayerChatService } from './player-chat.service.js';
import type { ChatTarget } from './player-chat.service.js';
import { ChatChannel } from './player-chat.contracts.js';
import {
  ChatChannelPageQueryDto,
  ChatCharacterRouteDto,
  ChatDirectHistoryRouteDto,
  ChatGroupRouteDto,
  ChatGuildRouteDto,
  ChatMessageDto,
  ChatMessagePageDto,
  ChatPageQueryDto,
  ChatTargetRouteDto,
  SendChatBodyDto,
} from './dto/player-chat.dto.js';

const IdempotencyHeader = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      '1–128 ASCII letters, digits or ._:-; scoped to the player. The same key with the same message replays it without sending again; with other content returns 409.',
  });
const SendResponses = () =>
  applyDecorators(
    HttpCode(201),
    IdempotencyHeader(),
    ApiCreatedResponse({ type: ChatMessageDto }),
    ApiTooManyRequestsResponse({
      type: HttpErrorDto,
      description: 'Send limit reached; see Retry-After.',
    }),
  );

// Chat is plain text over HTTP (history, source of truth); new messages are
// also pushed as CHAT_MESSAGE_CREATED on the existing realtime gateway.
abstract class ChatSender {
  constructor(protected readonly chat: PlayerChatService) {}
  protected async send(
    response: Response,
    auth: AuthenticatedPlayer,
    key: string | undefined,
    body: SendChatBodyDto,
    target: ChatTarget,
  ) {
    try {
      return await this.chat.send(
        auth.actor,
        key,
        body.characterLinkId,
        body.message,
        target,
      );
    } catch (error) {
      if (error instanceof ChatRateLimitedException)
        response.setHeader('Retry-After', String(error.retryAfter));
      throw error;
    }
  }
}

@ApiTags('player-chat')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/chat', version: '1' })
export class PlayerChatController extends ChatSender {
  constructor(chat: PlayerChatService) {
    super(chat);
  }
  @Post('global')
  @SendResponses()
  @ApiOperation({ summary: "Send to your character's server GLOBAL chat." })
  global(
    @Body() body: SendChatBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.send(response, auth, key, body, {
      channel: ChatChannel.GLOBAL,
    });
  }
  @Post('direct/:targetCharacterId')
  @SendResponses()
  @ApiOperation({
    summary: 'Send a DIRECT message to a character of your server.',
    description:
      'The conversation belongs to the two current ownership links; a new owner of either character never sees earlier messages.',
  })
  direct(
    @Param() route: ChatTargetRouteDto,
    @Body() body: SendChatBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.send(response, auth, key, body, {
      channel: ChatChannel.DIRECT,
      targetCharacterId: route.targetCharacterId,
    });
  }
}

@ApiTags('player-chat')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Not an active member through this character.',
})
@ApiConflictResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/groups/:groupId/chat', version: '1' })
export class GroupChatController extends ChatSender {
  constructor(chat: PlayerChatService) {
    super(chat);
  }
  @Post()
  @SendResponses()
  @ApiOperation({ summary: 'Send to a group you are an active member of.' })
  sendToGroup(
    @Param() route: ChatGroupRouteDto,
    @Body() body: SendChatBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.send(response, auth, key, body, {
      channel: ChatChannel.GROUP,
      groupId: route.groupId,
    });
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Group chat history, newest first.' })
  @ApiOkResponse({ type: ChatMessagePageDto })
  history(
    @Param() route: ChatGroupRouteDto,
    @Query() query: ChatChannelPageQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.chat.groupHistory(
      auth.actor,
      route.groupId,
      query.characterLinkId,
      query,
    );
  }
}

@ApiTags('player-chat')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Not an active member through this character.',
})
@ApiConflictResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/guilds/:guildId/chat', version: '1' })
export class GuildChatController extends ChatSender {
  constructor(chat: PlayerChatService) {
    super(chat);
  }
  @Post()
  @SendResponses()
  @ApiOperation({
    summary: 'Send to a guild your character is an active member of.',
  })
  sendToGuild(
    @Param() route: ChatGuildRouteDto,
    @Body() body: SendChatBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.send(response, auth, key, body, {
      channel: ChatChannel.GUILD,
      guildId: route.guildId,
    });
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Guild chat history, newest first.' })
  @ApiOkResponse({ type: ChatMessagePageDto })
  history(
    @Param() route: ChatGuildRouteDto,
    @Query() query: ChatChannelPageQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.chat.guildHistory(
      auth.actor,
      route.guildId,
      query.characterLinkId,
      query,
    );
  }
}

@ApiTags('player-chat')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/chat',
  version: '1',
})
export class CharacterChatController {
  constructor(private readonly chat: PlayerChatService) {}
  @Get('global')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "GLOBAL chat history of your character's server, newest first.",
  })
  @ApiOkResponse({ type: ChatMessagePageDto })
  global(
    @Param() route: ChatCharacterRouteDto,
    @Query() query: ChatPageQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.chat.globalHistory(auth.actor, route.characterLinkId, query);
  }
  @Get('direct/:targetCharacterId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'DIRECT history with a character, limited to the current owners of both.',
  })
  @ApiOkResponse({ type: ChatMessagePageDto })
  direct(
    @Param() route: ChatDirectHistoryRouteDto,
    @Query() query: ChatPageQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.chat.directHistory(
      auth.actor,
      route.characterLinkId,
      route.targetCharacterId,
      query,
    );
  }
}
