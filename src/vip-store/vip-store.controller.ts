import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { PageQueryDto } from '../admin-queries/dto/query.dto.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { VipAdminService } from './vip-admin.service.js';
import { VipCatalogService } from './vip-catalog.service.js';
import {
  CreateVipOfferDto,
  UpdateVipOfferDto,
  VipOfferActiveDto,
  VipOfferAdminDto,
  VipOfferPublicDto,
  VipAdminPageDto,
  VipCatalogPageDto,
} from './dto/vip-offer.dto.js';
// DTO class fields absent from JSON may be undefined; preserve only supplied values.
function input(dto: object) {
  return Object.fromEntries(
    Object.entries(dto).filter(([, value]) => value !== undefined),
  );
}
@ApiTags('vip-store-admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; mutation rolled back.',
})
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'admin/vip-store/offers', version: '1' })
export class VipAdminController {
  constructor(private readonly offers: VipAdminService) {}
  @Get()
  @RequirePermissions(P.VIP_STORE_READ)
  @ApiOkResponse({ type: VipAdminPageDto })
  list(@Query() query: PageQueryDto, @CurrentStaff() auth: AuthenticatedStaff) {
    return this.offers.list(query, auth);
  }
  @Get(':id')
  @RequirePermissions(P.VIP_STORE_READ)
  @ApiOkResponse({ type: VipOfferAdminDto })
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.offers.get(id, auth);
  }
  @Post()
  @RequirePermissions(P.VIP_STORE_WRITE)
  @ApiCreatedResponse({ type: VipOfferAdminDto })
  create(
    @Body() dto: CreateVipOfferDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.offers.create(input(dto), auth);
  }
  @Patch(':id')
  @RequirePermissions(P.VIP_STORE_WRITE)
  @ApiOkResponse({ type: VipOfferAdminDto })
  @ApiOperation({
    description:
      'Update supplied fields; code is immutable. Use /:id/active to activate or disable.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateVipOfferDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.offers.update(id, input(dto), auth);
  }
  @Patch(':id/active')
  @RequirePermissions(P.VIP_STORE_WRITE)
  @ApiOkResponse({ type: VipOfferAdminDto })
  active(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: VipOfferActiveDto,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.offers.setActive(id, dto.active, auth);
  }
}
@ApiTags('vip-store-catalog')
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@Controller({ path: 'vip-store/offers', version: '1' })
export class VipCatalogController {
  constructor(private readonly catalog: VipCatalogService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: VipCatalogPageDto })
  @ApiOperation({
    description:
      'Public, anonymous active catalog. Player authentication is not implemented. Ordered by sortOrder then code.',
  })
  list(@Query() query: PageQueryDto) {
    return this.catalog.list(query);
  }
  @Get(':code')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: VipOfferPublicDto })
  @ApiOperation({
    description:
      'Public, anonymous active offer by stable code. Inactive or missing offers return 404.',
  })
  get(@Param('code') code: string) {
    return this.catalog.get(code);
  }
}
