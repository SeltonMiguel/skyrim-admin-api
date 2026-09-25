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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { Permission as P } from '../rbac/permissions.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { AgentCredentialService } from './agent-credential.service.js';
import {
  AgentCredentialDto,
  AgentCredentialListDto,
  AgentCredentialRouteDto,
  AgentCredentialServerRouteDto,
  CreatedAgentCredentialDto,
  EmptyAgentCredentialBodyDto,
} from './dto/agent-credential.dto.js';

@ApiTags('game-agent-credentials')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; mutation rolled back.',
})
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(P.GAME_AGENT_CREDENTIAL_MANAGE)
@Controller({
  path: 'admin/game-servers/:gameServerId/agent-credentials',
  version: '1',
})
export class AgentCredentialController {
  constructor(private readonly credentials: AgentCredentialService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AgentCredentialListDto })
  async list(@Param() route: AgentCredentialServerRouteDto) {
    return { items: await this.credentials.list(route.gameServerId) };
  }
  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiCreatedResponse({ type: CreatedAgentCredentialDto })
  @ApiConflictResponse({
    type: HttpErrorDto,
    description: 'The server already has two ACTIVE credentials.',
  })
  @ApiOperation({
    description:
      'Issues a new ACTIVE Host Agent credential. The secret appears only in this response. At most two ACTIVE per server (rotation: create B, switch the Agent, revoke A).',
  })
  create(
    @Param() route: AgentCredentialServerRouteDto,
    @Body() _body: EmptyAgentCredentialBodyDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.credentials.create(route.gameServerId, auth);
  }
  @Post(':credentialId/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AgentCredentialDto })
  @ApiOperation({
    description:
      'ACTIVE -> REVOKED; repeating is a no-op. Closes the Agent session that uses it immediately.',
  })
  revoke(
    @Param() route: AgentCredentialRouteDto,
    @Body() _body: EmptyAgentCredentialBodyDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.credentials.revoke(
      route.gameServerId,
      route.credentialId,
      auth,
    );
  }
}
