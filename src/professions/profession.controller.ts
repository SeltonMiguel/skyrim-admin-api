import {
  Body,
  Controller,
  Get,
  Header,
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
import { ProfessionService } from './profession.service.js';
import {
  ProfessionDto,
  ProfessionRouteDto,
  SelectProfessionDto,
} from './dto/profession.dto.js';

@ApiTags('player-professions')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({
  type: HttpErrorDto,
  description: 'Character link not VERIFIED for this player.',
})
@UseGuards(PlayerAuthGuard)
@Controller({
  path: 'player/me/characters/:characterLinkId/profession',
  version: '1',
})
export class ProfessionController {
  constructor(private readonly professions: ProfessionService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: ProfessionDto })
  get(
    @Param() route: ProfessionRouteDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
  ) {
    return this.professions.get(auth.actor, route.characterLinkId);
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Select the profession of an owned character (one time).',
    description:
      '201 on first selection; 200 when repeating the same profession; 409 PROFESSION_ALREADY_SELECTED for a different one. Changing profession is not supported.',
  })
  @ApiCreatedResponse({ type: ProfessionDto })
  @ApiOkResponse({ type: ProfessionDto })
  @ApiConflictResponse({ type: HttpErrorDto })
  @ApiServiceUnavailableResponse({
    type: HttpErrorDto,
    description: 'Audit unavailable; nothing changed.',
  })
  async select(
    @Param() route: ProfessionRouteDto,
    @Body() dto: SelectProfessionDto,
    @CurrentPlayer() auth: AuthenticatedPlayer,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { state, created } = await this.professions.select(
      auth.actor,
      route.characterLinkId,
      dto.profession,
    );
    response.status(created ? 201 : 200);
    return state;
  }
}
