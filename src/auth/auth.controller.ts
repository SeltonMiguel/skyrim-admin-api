import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import {
  AuthResponseDto,
  LoginDto,
  MeDto,
  RefreshDto,
} from './dto/auth.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { CurrentStaff } from './decorators/current-staff.decorator.js';
import type { AuthenticatedStaff } from './auth.types.js';
import { publicStaff } from '../staff/staff.presenter.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';

@ApiTags('auth')
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiBadRequestResponse({ type: HttpErrorDto })
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AuthResponseDto })
  login(@Body() dto: LoginDto, @Req() request: Request) {
    return this.auth.login(dto, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ type: AuthResponseDto })
  refresh(@Body() dto: RefreshDto, @Req() request: Request) {
    return this.auth.refresh(dto.refreshToken, request.ip);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiNoContentResponse({
    description:
      'Current session revoked; access and refresh tokens immediately invalid.',
  })
  logout(@CurrentStaff() auth: AuthenticatedStaff) {
    return this.auth.logout(auth);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ type: MeDto })
  me(@CurrentStaff() auth: AuthenticatedStaff) {
    return { ...publicStaff(auth.user), permissions: auth.permissions };
  }
}
