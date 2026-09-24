import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { PlayerCharacterDirectoryService } from './player-character-directory.service.js';
import {
  PlayerCharacterDto,
  PlayerCharacterPageDto,
  PlayerCharacterRouteDto,
  PlayerCharactersQueryDto,
} from './dto/player-character.dto.js';

@ApiTags('player-characters')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/me/characters', version: '1' })
export class PlayerCharacterController {
  constructor(private readonly characters: PlayerCharacterDirectoryService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'List your PENDING and VERIFIED characters.',
    description:
      'Ordered VERIFIED first, then createdAt ASC, id ASC. REVOKED links are omitted. Identity only: query profile/skills separately.',
  })
  @ApiOkResponse({ type: PlayerCharacterPageDto })
  list(
    @Query() query: PlayerCharactersQueryDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.characters.list(auth.actor, query);
  }
  @Get(':characterLinkId')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: PlayerCharacterDto })
  @ApiNotFoundResponse({
    type: HttpErrorDto,
    description: 'Unknown, REVOKED or owned by another player.',
  })
  get(
    @Param() route: PlayerCharacterRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.characters.get(auth.actor, route.characterLinkId);
  }
}
