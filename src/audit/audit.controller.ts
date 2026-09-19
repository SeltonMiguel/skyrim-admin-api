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
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { Permission } from '../rbac/permissions.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { AuditQueryService } from './audit-query.service.js';
import { AuditQueryDto } from './dto/audit-query.dto.js';
import { AuditLogDto, AuditPageDto } from './dto/audit-response.dto.js';

@ApiTags('audit')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(Permission.AUDIT_READ)
@Controller({ path: 'audit', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}
  @Get()
  @ApiOkResponse({ type: AuditPageDto })
  list(@Query() query: AuditQueryDto) {
    return this.audit.list(query);
  }

  @Get(':id')
  @ApiOkResponse({ type: AuditLogDto })
  @ApiNotFoundResponse({ type: HttpErrorDto })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.audit.get(id);
  }
}
