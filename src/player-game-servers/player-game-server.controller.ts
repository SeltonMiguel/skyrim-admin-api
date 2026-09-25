import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { PlayerAuthGuard } from '../player-auth/player-auth.guard.js';
import {
  PlayerGameServerPageDto,
  PlayerGameServersQueryDto,
} from './player-game-server.dto.js';
import { PlayerGameServerService } from './player-game-server.service.js';

@ApiTags('player-game-servers')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@UseGuards(PlayerAuthGuard)
@Controller({ path: 'player/game-servers', version: '1' })
export class PlayerGameServerController {
  constructor(private readonly servers: PlayerGameServerService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: PlayerGameServerPageDto })
  list(@Query() query: PlayerGameServersQueryDto) {
    return this.servers.list(query);
  }
}
