import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { idempotencyKey } from '../actor-operations/actor-command.service.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { PlayerCharacterOperationService } from './player-character-operation.service.js';
import type { PlayerCharacterQueryType } from './player-character-query.contracts.js';
import {
  EmptyPlayerQueryBodyDto,
  PlayerCharacterOperationDto,
  PlayerCharacterOperationReferenceDto,
  PlayerCharacterRouteDto,
  PlayerOperationRouteDto,
} from './dto/player-character-operation.dto.js';

function ApiPlayerQueryAccepted() {
  return ApiAcceptedResponse({
    type: PlayerCharacterOperationReferenceDto,
    description: 'Accepted and persisted; not Skyrim execution success.',
    headers: {
      Location: {
        schema: { type: 'string' },
        description: '/api/v1/player/character-operations/{operationId}',
      },
    },
  });
}
@ApiTags('player-characters')
@ApiBearerAuth()
@ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: '1–128 ASCII letters, digits or ._:-; scoped to the player.',
})
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Server unknown or character not VERIFIED for this player.',
})
@ApiConflictResponse({
  type: HttpErrorDto,
  description: 'Server disabled or Idempotency-Key reused with other content.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/game-servers/:gameServerId/characters/:characterId',
  version: '1',
})
export class PlayerCharacterQueryController {
  constructor(private readonly operations: PlayerCharacterOperationService) {}
  private async accepted(
    type: PlayerCharacterQueryType,
    route: PlayerCharacterRouteDto,
    key: string | undefined,
    auth: AuthenticatedPlayer,
    response: Response,
  ) {
    const reference = await this.operations.request(
      auth.actor,
      type,
      route,
      idempotencyKey(key),
    );
    response.setHeader(
      'Location',
      `/api/v1/player/character-operations/${reference.operationId}`,
    );
    return reference;
  }
  @Post('profile-query')
  @HttpCode(202)
  @ApiPlayerQueryAccepted()
  @ApiOperation({ summary: 'CHARACTER_PROFILE_QUERY for an owned character.' })
  profile(
    @Param() route: PlayerCharacterRouteDto,
    @Body() _body: EmptyPlayerQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted('CHARACTER_PROFILE_QUERY', route, key, auth, response);
  }
  @Post('skills-query')
  @HttpCode(202)
  @ApiPlayerQueryAccepted()
  @ApiOperation({ summary: 'CHARACTER_SKILLS_QUERY for an owned character.' })
  skills(
    @Param() route: PlayerCharacterRouteDto,
    @Body() _body: EmptyPlayerQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted('CHARACTER_SKILLS_QUERY', route, key, auth, response);
  }
  // Read-only: properties are the player's houses. No purchase, sale, grant
  // or revoke is exposed to players.
  @Post('properties-query')
  @HttpCode(202)
  @ApiPlayerQueryAccepted()
  @ApiOperation({
    summary: 'CHARACTER_PROPERTIES_QUERY (houses) for an owned character.',
  })
  properties(
    @Param() route: PlayerCharacterRouteDto,
    @Body() _body: EmptyPlayerQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      'CHARACTER_PROPERTIES_QUERY',
      route,
      key,
      auth,
      response,
    );
  }
  @Post('holds-query')
  @HttpCode(202)
  @ApiPlayerQueryAccepted()
  @ApiOperation({ summary: 'CHARACTER_HOLDS_QUERY for an owned character.' })
  holds(
    @Param() route: PlayerCharacterRouteDto,
    @Body() _body: EmptyPlayerQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted('CHARACTER_HOLDS_QUERY', route, key, auth, response);
  }
}
@ApiTags('player-characters')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/character-operations', version: '1' })
export class PlayerCharacterOperationController {
  constructor(private readonly operations: PlayerCharacterOperationService) {}
  @Get(':operationId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read one of your character query operations.',
    description:
      'Other players, staff or unrelated commands return 404. Results are validated Skyrim data; nothing is cached.',
  })
  @ApiOkResponse({ type: PlayerCharacterOperationDto })
  get(
    @Param() route: PlayerOperationRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.operations.get(auth.actor, route.operationId);
  }
}
