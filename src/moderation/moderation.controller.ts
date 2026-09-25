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
import {
  PermissionsCheckedInService,
  RequirePermissions,
} from '../rbac/require-permissions.decorator.js';
import { Permission as P } from '../rbac/permissions.js';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { idempotencyKey } from '../administrative-operations/administrative-command.service.js';
import { ModerationService } from './moderation.service.js';
import {
  ModerationServerRouteDto,
  ModerationPlayerRouteDto,
  BanBodyDto,
  ModeBodyDto,
  AnnouncementBodyDto,
  TeleportBodyDto,
  EmptyModerationBodyDto,
} from './dto/moderation.dto.js';
import {
  ModerationOperationDetailDto,
  ModerationOperationReferenceDto,
} from './dto/operation.dto.js';
function ApiModerationAcceptedResponse() {
  return ApiAcceptedResponse({
    type: ModerationOperationReferenceDto,
    description: 'Accepted and persisted; not Skyrim execution success.',
    headers: {
      Location: {
        schema: { type: 'string' },
        description: '/api/v1/moderation-operations/{commandId}',
      },
    },
  });
}
@ApiTags('moderation')
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
@Controller({ path: 'game-servers/:serverId/moderation', version: '1' })
export class ModerationController {
  constructor(private readonly operations: ModerationService) {}
  private async accepted(
    operation: Promise<ModerationOperationReferenceDto>,
    response: Response,
  ) {
    const reference = await operation;
    response.setHeader(
      'Location',
      `/api/v1/moderation-operations/${reference.commandId}`,
    );
    return reference;
  }
  @Post('players/:playerId/ban')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.PLAYER_BAN)
  @ApiOperation({
    summary: 'PLAYER_BAN',
    description:
      'Requires PLAYER_BAN. 202 means accepted/persisted, not Skyrim execution success.',
  })
  player_ban(
    @Param() route: ModerationPlayerRouteDto,
    @Body() body: BanBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'PLAYER_BAN',
          payload: {
            playerId: route.playerId,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('players/:playerId/unban')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.PLAYER_UNBAN)
  @ApiOperation({
    summary: 'PLAYER_UNBAN',
    description:
      'Requires PLAYER_UNBAN. 202 means accepted/persisted, not Skyrim execution success.',
  })
  player_unban(
    @Param() route: ModerationPlayerRouteDto,
    @Body() body: BanBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'PLAYER_UNBAN',
          payload: {
            playerId: route.playerId,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('players/:playerId/god-mode')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.PLAYER_GOD_MODE)
  @ApiOperation({
    summary: 'PLAYER_GOD_MODE_SET',
    description:
      'Requires PLAYER_GOD_MODE. 202 means accepted/persisted, not Skyrim execution success.',
  })
  player_god_mode_set(
    @Param() route: ModerationPlayerRouteDto,
    @Body() body: ModeBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'PLAYER_GOD_MODE_SET',
          payload: { playerId: route.playerId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('staff/me/noclip')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.STAFF_NOCLIP)
  @ApiOperation({
    summary: 'STAFF_NOCLIP_SET',
    description:
      'Requires STAFF_NOCLIP. 202 means accepted/persisted, not Skyrim execution success.',
  })
  staff_noclip_set(
    @Param() route: ModerationServerRouteDto,
    @Body() body: ModeBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'STAFF_NOCLIP_SET',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('staff/me/invisibility')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.STAFF_INVISIBILITY)
  @ApiOperation({
    summary: 'STAFF_INVISIBILITY_SET',
    description:
      'Requires STAFF_INVISIBILITY. 202 means accepted/persisted, not Skyrim execution success.',
  })
  staff_invisibility_set(
    @Param() route: ModerationServerRouteDto,
    @Body() body: ModeBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'STAFF_INVISIBILITY_SET',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('announcements')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.ANNOUNCEMENT_SEND)
  @ApiOperation({
    summary: 'ANNOUNCEMENT_SEND',
    description:
      'Requires ANNOUNCEMENT_SEND. 202 means accepted/persisted, not Skyrim execution success.',
  })
  announcement_send(
    @Param() route: ModerationServerRouteDto,
    @Body() body: AnnouncementBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'ANNOUNCEMENT_SEND',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('staff/me/teleport-to-player')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.STAFF_TELEPORT_TO_PLAYER)
  @ApiOperation({
    summary: 'STAFF_TELEPORT_TO_PLAYER',
    description:
      'Requires STAFF_TELEPORT_TO_PLAYER. 202 means accepted/persisted, not Skyrim execution success.',
  })
  staff_teleport_to_player(
    @Param() route: ModerationServerRouteDto,
    @Body() body: TeleportBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'STAFF_TELEPORT_TO_PLAYER',
          payload: { ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('players/:playerId/teleport-to-me')
  @HttpCode(202)
  @ApiModerationAcceptedResponse()
  @RequirePermissions(P.PLAYER_TELEPORT_TO_STAFF)
  @ApiOperation({
    summary: 'PLAYER_TELEPORT_TO_STAFF',
    description:
      'Requires PLAYER_TELEPORT_TO_STAFF. 202 means accepted/persisted, not Skyrim execution success.',
  })
  player_teleport_to_staff(
    @Param() route: ModerationPlayerRouteDto,
    @Body() body: EmptyModerationBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'PLAYER_TELEPORT_TO_STAFF',
          payload: { targetPlayerId: route.playerId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
}
@ApiTags('moderation')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'moderation-operations', version: '1' })
export class ModerationOperationController {
  constructor(private readonly operations: ModerationService) {}
  @Get(':commandId')
  // Permission of the stored type, checked by the service (12.1).
  @PermissionsCheckedInService()
  @ApiOperation({
    summary: 'Read a typed Moderation operation.',
    description:
      'Requires the permission for the stored CommandType; GAME_BRIDGE_READ alone is insufficient. Non-Moderation commands return 404.',
  })
  @ApiOkResponse({ type: ModerationOperationDetailDto })
  get(
    @Param('commandId', new ParseUUIDPipe()) id: string,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.operations.get(id, auth);
  }
}
