import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import {
  CurrentPlayer,
  PlayerAuthGuard,
} from '../player-auth/player-auth.guard.js';
import { PlayerAuthRateLimitGuard } from '../player-auth/player-auth-rate-limit.js';
import type { AuthenticatedPlayer } from '../player-auth/player-auth.types.js';
import { CharacterLinkService } from './character-link.service.js';
import type { PlayerCharacter } from './entities/player-character.entity.js';
import {
  CharacterLinkCreatedDto,
  CharacterLinkDto,
  CharacterLinkRouteDto,
  CreateCharacterLinkDto,
  EmptyCharacterLinkBodyDto,
} from './dto/character-link.dto.js';

export function characterLink(link: PlayerCharacter): CharacterLinkDto {
  return {
    linkId: link.id,
    gameServerId: link.gameServerId,
    characterExternalId: link.characterExternalId,
    status: link.status,
    verifiedAt: link.verifiedAt,
    revokedAt: link.revokedAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

@ApiTags('player-characters')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; nothing changed.',
})
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/character-links', version: '1' })
export class CharacterLinkController {
  constructor(private readonly links: CharacterLinkService) {}
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlayerAuthRateLimitGuard)
  @ApiOperation({
    summary: 'Request ownership of an in-game character.',
    description:
      'Creates or reopens a PENDING link and returns a one-time challenge. Ownership becomes VERIFIED only after the game Agent confirms the challenge.',
  })
  @ApiCreatedResponse({ type: CharacterLinkCreatedDto })
  @ApiConflictResponse({
    type: HttpErrorDto,
    description: 'Server disabled, character unavailable or already verified.',
  })
  @ApiTooManyRequestsResponse({ type: HttpErrorDto })
  async create(
    @Body() dto: CreateCharacterLinkDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ): Promise<CharacterLinkCreatedDto> {
    const { link, challenge, expiresAt } = await this.links.request(
      auth.actor,
      dto,
    );
    return { ...characterLink(link), challenge, challengeExpiresAt: expiresAt };
  }
  @Get(':linkId')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: CharacterLinkDto })
  async get(
    @Param() route: CharacterLinkRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ): Promise<CharacterLinkDto> {
    return characterLink(await this.links.get(auth.actor, route.linkId));
  }
  @Post(':linkId/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke one of your own character links.',
    description: 'PENDING or VERIFIED → REVOKED; history is kept.',
  })
  @ApiOkResponse({ type: CharacterLinkDto })
  async revoke(
    @Param() route: CharacterLinkRouteDto,
    @Body() _body: EmptyCharacterLinkBodyDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ): Promise<CharacterLinkDto> {
    return characterLink(await this.links.revoke(auth.actor, route.linkId));
  }
}
