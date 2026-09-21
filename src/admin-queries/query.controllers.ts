import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { Permission } from '../rbac/permissions.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { DashboardQueryService } from './dashboard-query.service.js';
import { GameServerQueryService } from './game-server-query.service.js';
import { GameCommandQueryService } from './game-command-query.service.js';
import {
  CommandQueryDto,
  ConnectionQueryDto,
  EmptyQueryDto,
  ServerQueryDto,
} from './dto/query.dto.js';
import {
  CommandDetailDto,
  CommandPageDto,
  ConnectionPageDto,
  DashboardDto,
  GameServerDto,
  ServerPageDto,
} from './dto/response.dto.js';

@ApiTags('dashboard')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(Permission.DASHBOARD_READ)
@Controller({ path: 'dashboard', version: '1' })
export class DashboardController {
  constructor(private readonly dashboard: DashboardQueryService) {}
  @Get()
  @ApiOperation({
    summary:
      'Read operational counters; fixed 24-hour command creation window.',
  })
  @ApiOkResponse({ type: DashboardDto })
  get(@Query() _query: EmptyQueryDto) {
    return this.dashboard.get();
  }
}

@ApiTags('game-servers')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(Permission.GAME_BRIDGE_READ)
@Controller({ path: 'game-servers', version: '1' })
export class GameServerQueryController {
  constructor(
    private readonly servers: GameServerQueryService,
    private readonly commands: GameCommandQueryService,
  ) {}
  @Get()
  @ApiOperation({ summary: 'List servers ordered by name ASC, id ASC.' })
  @ApiOkResponse({ type: ServerPageDto })
  list(@Query() query: ServerQueryDto) {
    return this.servers.list(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: GameServerDto })
  @ApiNotFoundResponse({ type: HttpErrorDto })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.servers.get(id);
  }

  @Get(':id/connections')
  @ApiOperation({
    summary:
      'Connection history; dates filter connectedAt; order connectedAt DESC, id DESC.',
  })
  @ApiOkResponse({ type: ConnectionPageDto })
  @ApiNotFoundResponse({ type: HttpErrorDto })
  connections(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ConnectionQueryDto,
  ) {
    return this.servers.connections(id, query);
  }

  @Get(':id/commands')
  @ApiOperation({
    summary:
      'Command summaries; dates filter createdAt; order createdAt DESC, id DESC.',
  })
  @ApiOkResponse({ type: CommandPageDto })
  @ApiNotFoundResponse({ type: HttpErrorDto })
  commandsList(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: CommandQueryDto,
  ) {
    return this.commands.list(id, query);
  }
}

@ApiTags('game-commands')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(Permission.GAME_BRIDGE_READ)
@Controller({ path: 'game-commands', version: '1' })
export class GameCommandQueryController {
  constructor(private readonly commands: GameCommandQueryService) {}
  @Get(':id')
  @ApiOkResponse({ type: CommandDetailDto })
  @ApiNotFoundResponse({ type: HttpErrorDto })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.commands.get(id);
  }
}
