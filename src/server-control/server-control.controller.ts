import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { ServerControlService } from './server-control.service.js';
import type { ServerControlType } from './server-control.contracts.js';
import {
  EmptyServerControlBodyDto,
  ServerControlListQueryDto,
  ServerControlOperationDetailDto,
  ServerControlOperationPageDto,
  ServerControlOperationReferenceDto,
  ServerControlRouteDto,
} from './dto/server-control.dto.js';

function ApiServerControlAccepted() {
  return ApiAcceptedResponse({
    type: ServerControlOperationReferenceDto,
    description:
      'Request accepted and persisted; not proof that the server changed state.',
    headers: {
      Location: {
        schema: { type: 'string' },
        description: '/api/v1/server-control-operations/{operationId}',
      },
    },
  });
}
@ApiTags('server-control')
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
@ApiConflictResponse({
  type: HttpErrorDto,
  description: 'Server disabled, or Idempotency-Key used by another operation.',
})
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; operation rolled back.',
})
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'game-servers/:serverId/control', version: '1' })
export class ServerControlController {
  constructor(private readonly operations: ServerControlService) {}
  private async accepted(
    route: ServerControlRouteDto,
    type: ServerControlType,
    key: string | undefined,
    auth: AuthenticatedStaff,
    response: Response,
  ) {
    const reference = await this.operations.request(
      route.serverId,
      type,
      key,
      auth,
    );
    response.setHeader(
      'Location',
      `/api/v1/server-control-operations/${reference.operationId}`,
    );
    return reference;
  }
  @Post('start')
  @HttpCode(202)
  @ApiServerControlAccepted()
  @RequirePermissions(P.SERVER_START)
  @ApiOperation({
    summary: 'SERVER_START',
    description:
      'Requires SERVER_START. Requests server start from the future Agent; accepted/persisted only.',
  })
  start(
    @Param() route: ServerControlRouteDto,
    @Body() _body: EmptyServerControlBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(route, 'SERVER_START', key, auth, response);
  }
  @Post('pause')
  @HttpCode(202)
  @ApiServerControlAccepted()
  @RequirePermissions(P.SERVER_PAUSE)
  @ApiOperation({
    summary: 'SERVER_PAUSE',
    description:
      'Requires SERVER_PAUSE. Requests an operational pause as defined by the future Agent; accepted/persisted only.',
  })
  pause(
    @Param() route: ServerControlRouteDto,
    @Body() _body: EmptyServerControlBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(route, 'SERVER_PAUSE', key, auth, response);
  }
  @Post('restart')
  @HttpCode(202)
  @ApiServerControlAccepted()
  @RequirePermissions(P.SERVER_RESTART)
  @ApiOperation({
    summary: 'SERVER_RESTART',
    description:
      'Requires SERVER_RESTART. Requests a controlled restart from the future Agent; accepted/persisted only.',
  })
  restart(
    @Param() route: ServerControlRouteDto,
    @Body() _body: EmptyServerControlBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(route, 'SERVER_RESTART', key, auth, response);
  }
}
@ApiTags('server-control')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'server-control-operations', version: '1' })
export class ServerControlOperationController {
  constructor(private readonly operations: ServerControlService) {}
  @Get(':operationId')
  // Permission of the stored type, checked by the service (12.1).
  @PermissionsCheckedInService()
  @ApiOperation({
    summary: 'Read a Server Control operation.',
    description:
      'Requires the permission for the stored type (SERVER_START, SERVER_PAUSE or SERVER_RESTART). Game commands return 404.',
  })
  @ApiOkResponse({ type: ServerControlOperationDetailDto })
  get(
    @Param('operationId', new ParseUUIDPipe()) id: string,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.operations.get(id, auth);
  }
}
@ApiTags('server-control')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'game-servers/:serverId/control/operations', version: '1' })
export class ServerControlOperationListController {
  constructor(private readonly operations: ServerControlService) {}
  @Get()
  // Readable types filtered by the service (12.1).
  @PermissionsCheckedInService()
  @ApiOperation({
    summary: 'List the Server Control operations of a server.',
    description:
      'Requires at least one of SERVER_START, SERVER_PAUSE or SERVER_RESTART; only the types the caller holds are listed. Order createdAt DESC, id DESC. Recovery read for a client without known operation ids (in flight, UNCERTAIN).',
  })
  @ApiOkResponse({ type: ServerControlOperationPageDto })
  list(
    @Param() route: ServerControlRouteDto,
    @Query() query: ServerControlListQueryDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.operations.list(route.serverId, query, auth);
  }
}
