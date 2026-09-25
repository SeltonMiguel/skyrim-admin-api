import {
  Body,
  Controller,
  Get,
  Header,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { PlayerGuildService } from './player-guild.service.js';
import {
  CharacterGuildDto,
  CreateGuildBodyDto,
  GuildActorBodyDto,
  GuildCharacterDto,
  GuildCharacterRouteDto,
  GuildDisbandDto,
  GuildDto,
  GuildInviteBodyDto,
  GuildInviteDto,
  GuildInviteListDto,
  GuildInviteRouteDto,
  GuildLeaveDto,
  GuildMemberRouteDto,
  GuildRoleBodyDto,
  GuildRouteDto,
} from './dto/player-guild.dto.js';

@ApiTags('player-guilds')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({
  type: HttpErrorDto,
  description: 'Member whose guild role does not allow the action.',
})
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; nothing changed.',
})
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/guilds', version: '1' })
export class PlayerGuildController {
  constructor(private readonly guilds: PlayerGuildService) {}
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a guild; your VERIFIED character becomes its MASTER.',
  })
  @ApiCreatedResponse({ type: GuildDto })
  create(
    @Body() body: CreateGuildBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.create(auth.actor, body);
  }
  @Get(':guildId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read an active guild your character (characterLinkId) is in.',
  })
  @ApiOkResponse({ type: GuildDto })
  get(
    @Param() route: GuildRouteDto,
    @Query() query: GuildCharacterDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.get(auth.actor, route.guildId, query.characterLinkId);
  }
  @Post(':guildId/invites')
  @ApiOperation({
    summary:
      'Invite a VERIFIED character of the guild server (MASTER or OFFICER).',
    description:
      '201 for a new invite; 200 when the same invite is still pending.',
  })
  @ApiCreatedResponse({ type: GuildInviteDto })
  @ApiOkResponse({ type: GuildInviteDto })
  async invite(
    @Param() route: GuildRouteDto,
    @Body() body: GuildInviteBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { invite, created } = await this.guilds.invite(
      auth.actor,
      route.guildId,
      body,
    );
    response.status(created ? 201 : 200);
    return invite;
  }
  @Post(':guildId/leave')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Leave the guild (MEMBER or OFFICER); the MASTER gets 409.',
  })
  @ApiOkResponse({ type: GuildLeaveDto })
  leave(
    @Param() route: GuildRouteDto,
    @Body() body: GuildCharacterDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.leave(auth.actor, route.guildId, body.characterLinkId);
  }
  @Post(':guildId/members/:memberId/kick')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove an OFFICER or MEMBER (MASTER only).' })
  @ApiOkResponse({ type: GuildDto })
  kick(
    @Param() route: GuildMemberRouteDto,
    @Body() body: GuildActorBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.kick(
      auth.actor,
      route.guildId,
      route.memberId,
      body.actorCharacterLinkId,
    );
  }
  @Post(':guildId/members/:memberId/role')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Promote to OFFICER or demote to MEMBER (MASTER only).',
  })
  @ApiOkResponse({ type: GuildDto })
  changeRole(
    @Param() route: GuildMemberRouteDto,
    @Body() body: GuildRoleBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.changeRole(
      auth.actor,
      route.guildId,
      route.memberId,
      body,
    );
  }
  @Post(':guildId/members/:memberId/transfer-master')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Hand mastership to another member; the current MASTER becomes OFFICER.',
  })
  @ApiOkResponse({ type: GuildDto })
  transferMaster(
    @Param() route: GuildMemberRouteDto,
    @Body() body: GuildActorBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.transferMaster(
      auth.actor,
      route.guildId,
      route.memberId,
      body.actorCharacterLinkId,
    );
  }
  @Post(':guildId/disband')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disband the guild (MASTER only).' })
  @ApiOkResponse({ type: GuildDisbandDto })
  disband(
    @Param() route: GuildRouteDto,
    @Body() body: GuildActorBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.disband(
      auth.actor,
      route.guildId,
      body.actorCharacterLinkId,
    );
  }
}
@ApiTags('player-guilds')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; nothing changed.',
})
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/guild-invites', version: '1' })
export class PlayerGuildInviteController {
  constructor(private readonly guilds: PlayerGuildService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Pending invites to one of your VERIFIED characters.',
  })
  @ApiOkResponse({ type: GuildInviteListDto })
  list(
    @Query() query: GuildCharacterDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.listInvites(auth.actor, query.characterLinkId);
  }
  @Post(':inviteId/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: GuildDto })
  accept(
    @Param() route: GuildInviteRouteDto,
    @Body() body: GuildCharacterDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.accept(auth.actor, route.inviteId, body.characterLinkId);
  }
  @Post(':inviteId/decline')
  @HttpCode(200)
  @ApiOkResponse({ type: GuildInviteDto })
  decline(
    @Param() route: GuildInviteRouteDto,
    @Body() body: GuildCharacterDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.decline(
      auth.actor,
      route.inviteId,
      body.characterLinkId,
    );
  }
}
@ApiTags('player-guilds')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/guild',
  version: '1',
})
export class CharacterGuildController {
  constructor(private readonly guilds: PlayerGuildService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Active guild of your character, or { guild: null }.',
  })
  @ApiOkResponse({ type: CharacterGuildDto })
  get(
    @Param() route: GuildCharacterRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.guilds.forCharacter(auth.actor, route.characterLinkId);
  }
}
