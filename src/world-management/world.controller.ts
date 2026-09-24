import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { Permission as P } from '../rbac/permissions.js';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { idempotencyKey } from '../administrative-operations/administrative-command.service.js';
import { WorldService } from './world.service.js';
import {
  WorldServerRouteDto,
  EmptyWorldBodyDto,
  WorldTimeBodyDto,
  WorldWeatherBodyDto,
  WorldSpawnBodyDto,
} from './dto/world.dto.js';
import {
  WorldOperationDetailDto,
  WorldOperationReferenceDto,
} from './dto/operation.dto.js';
function ApiWorldAcceptedResponse() {
  return ApiAcceptedResponse({
    type: WorldOperationReferenceDto,
    description: 'Accepted and persisted; not Skyrim execution success.',
    headers: {
      Location: {
        schema: { type: 'string' },
        description: '/api/v1/world-operations/{commandId}',
      },
    },
  });
}
@ApiTags('world')
@ApiBearerAuth()
@ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description: '1–128 ASCII letters, digits or ._:-; scoped to server.',
})
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; command rolled back.',
})
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'game-servers/:serverId/world', version: '1' })
export class WorldController {
  constructor(private readonly operations: WorldService) {}
  private async accepted(
    operation: Promise<WorldOperationReferenceDto>,
    response: Response,
  ) {
    const reference = await operation;
    response.setHeader(
      'Location',
      `/api/v1/world-operations/${reference.commandId}`,
    );
    return reference;
  }
  @Post('state/query')
  @HttpCode(202)
  @ApiWorldAcceptedResponse()
  @RequirePermissions(P.WORLD_READ)
  @ApiOperation({
    summary: 'WORLD_STATE_QUERY',
    description:
      'Requires WORLD_READ. Accepted/persisted, not confirmed Skyrim execution.',
  })
  world_state_query(
    @Param() route: WorldServerRouteDto,
    @Body() body: EmptyWorldBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'WORLD_STATE_QUERY',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('time')
  @HttpCode(202)
  @ApiWorldAcceptedResponse()
  @RequirePermissions(P.WORLD_TIME_WRITE)
  @ApiOperation({
    summary: 'WORLD_TIME_SET',
    description:
      'Requires WORLD_TIME_WRITE. Accepted/persisted, not confirmed Skyrim execution.',
  })
  world_time_set(
    @Param() route: WorldServerRouteDto,
    @Body() body: WorldTimeBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'WORLD_TIME_SET',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('weather')
  @HttpCode(202)
  @ApiWorldAcceptedResponse()
  @RequirePermissions(P.WORLD_WEATHER_WRITE)
  @ApiOperation({
    summary: 'WORLD_WEATHER_SET',
    description:
      'Requires WORLD_WEATHER_WRITE. Accepted/persisted, not confirmed Skyrim execution.',
  })
  world_weather_set(
    @Param() route: WorldServerRouteDto,
    @Body() body: WorldWeatherBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'WORLD_WEATHER_SET',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('spawn')
  @HttpCode(202)
  @ApiWorldAcceptedResponse()
  @RequirePermissions(P.WORLD_ENTITY_SPAWN)
  @ApiOperation({
    summary: 'WORLD_ENTITY_SPAWN',
    description:
      'Requires WORLD_ENTITY_SPAWN. Accepted/persisted, not confirmed Skyrim execution.',
  })
  world_entity_spawn(
    @Param() route: WorldServerRouteDto,
    @Body() body: WorldSpawnBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'WORLD_ENTITY_SPAWN',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
}
@ApiTags('world')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'world-operations', version: '1' })
export class WorldOperationController {
  constructor(private readonly operations: WorldService) {}
  @Get(':commandId')
  @ApiOperation({
    summary: 'Read a typed World operation.',
    description:
      'Requires the permission for the stored CommandType; GAME_BRIDGE_READ alone is insufficient. Non-World commands return 404.',
  })
  @ApiOkResponse({ type: WorldOperationDetailDto })
  get(
    @Param('commandId', new ParseUUIDPipe()) id: string,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.operations.get(id, auth);
  }
}
