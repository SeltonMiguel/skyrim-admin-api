import { CurrentStaff } from '../auth/decorators/current-staff.decorator.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { StaffService } from './staff.service.js';
import {
  CreateStaffDto,
  StaffPublicDto,
  UpdateRoleDto,
  UpdateStaffDto,
  UpdateStatusDto,
} from './dto/staff.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { Permission } from '../rbac/permissions.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';

@ApiTags('staff')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermissions(Permission.STAFF_READ)
  @ApiOkResponse({ type: StaffPublicDto, isArray: true })
  list() {
    return this.staff.list();
  }

  @Get(':id')
  @RequirePermissions(Permission.STAFF_READ)
  @ApiOkResponse({ type: StaffPublicDto })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.staff.get(id);
  }

  @Post()
  @RequirePermissions(Permission.STAFF_WRITE)
  @ApiCreatedResponse({ type: StaffPublicDto })
  create(
    @Body() dto: CreateStaffDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.staff.create(dto, auth.user);
  }

  @Patch(':id')
  @RequirePermissions(Permission.STAFF_WRITE)
  @ApiOkResponse({ type: StaffPublicDto })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStaffDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.staff.update(id, dto, auth.user);
  }

  @Patch(':id/role')
  @RequirePermissions(Permission.STAFF_WRITE)
  @ApiOkResponse({ type: StaffPublicDto })
  role(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.staff.updateRole(id, dto.role, auth.user);
  }

  @Patch(':id/status')
  @RequirePermissions(Permission.STAFF_WRITE)
  @ApiOkResponse({ type: StaffPublicDto })
  status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.staff.updateStatus(id, dto.status, auth.user);
  }
}
