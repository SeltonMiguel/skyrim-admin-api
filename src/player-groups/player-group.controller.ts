import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
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
import { PlayerGroupService } from './player-group.service.js';
import {
  CharacterGroupDto,
  EmptyGroupBodyDto,
  GroupCharacterBodyDto,
  GroupDto,
  GroupInviteBodyDto,
  GroupInviteDto,
  GroupInviteListDto,
  GroupInviteRouteDto,
  GroupMemberRouteDto,
  GroupRouteDto,
} from './dto/player-group.dto.js';

@ApiTags('player-groups')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; nothing changed.',
})
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/groups', version: '1' })
export class PlayerGroupController {
  constructor(private readonly groups: PlayerGroupService) {}
  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a group led by your VERIFIED character.' })
  @ApiCreatedResponse({ type: GroupDto })
  create(
    @Body() body: GroupCharacterBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.create(auth.actor, body.characterLinkId);
  }
  @Get(':groupId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read an active group you are a member of.' })
  @ApiOkResponse({ type: GroupDto })
  get(
    @Param() route: GroupRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.get(auth.actor, route.groupId);
  }
  @Post(':groupId/invites')
  @ApiOperation({
    summary: 'Invite a VERIFIED character on the same server (leader only).',
    description:
      '201 for a new invite; 200 when the same invite is still pending.',
  })
  @ApiCreatedResponse({ type: GroupInviteDto })
  async invite(
    @Param() route: GroupRouteDto,
    @Body() body: GroupInviteBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { invite, created } = await this.groups.invite(
      auth.actor,
      route.groupId,
      body,
    );
    response.status(created ? 201 : 200);
    return invite;
  }
  @Post(':groupId/leave')
  @HttpCode(200)
  @ApiOperation({ summary: 'Leave a group; the leader leaving disbands it.' })
  leave(
    @Param() route: GroupRouteDto,
    @Body() body: GroupCharacterBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.leave(auth.actor, route.groupId, body.characterLinkId);
  }
  @Post(':groupId/members/:memberId/kick')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a member (leader only).' })
  @ApiOkResponse({ type: GroupDto })
  kick(
    @Param() route: GroupMemberRouteDto,
    @Body() _body: EmptyGroupBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.kick(auth.actor, route.groupId, route.memberId);
  }
  @Post(':groupId/disband')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disband the group (leader only).' })
  disband(
    @Param() route: GroupRouteDto,
    @Body() _body: EmptyGroupBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.disband(auth.actor, route.groupId);
  }
}
@ApiTags('player-groups')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/group-invites', version: '1' })
export class PlayerGroupInviteController {
  constructor(private readonly groups: PlayerGroupService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Pending invites to your VERIFIED characters.' })
  @ApiOkResponse({ type: GroupInviteListDto })
  list(@CurrentPlayer() auth: AuthenticatedPlayer) {
    return this.groups.listInvites(auth.actor);
  }
  @Post(':inviteId/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: GroupDto })
  accept(
    @Param() route: GroupInviteRouteDto,
    @Body() _body: EmptyGroupBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.accept(auth.actor, route.inviteId);
  }
  @Post(':inviteId/decline')
  @HttpCode(200)
  @ApiOkResponse({ type: GroupInviteDto })
  decline(
    @Param() route: GroupInviteRouteDto,
    @Body() _body: EmptyGroupBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.decline(auth.actor, route.inviteId);
  }
}
// Cold-start recovery (11.6): the current group of one of your characters,
// for a client that knows no groupId. One active membership per character
// link is a database invariant, so this is a single optional group.
@ApiTags('player-groups')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/group',
  version: '1',
})
export class CharacterGroupController {
  constructor(private readonly groups: PlayerGroupService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Active group of your character, or { group: null }.',
  })
  @ApiOkResponse({ type: CharacterGroupDto })
  get(
    @Param() route: GroupCharacterBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.groups.forCharacter(auth.actor, route.characterLinkId);
  }
}
