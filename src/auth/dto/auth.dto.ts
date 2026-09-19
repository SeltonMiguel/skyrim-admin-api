import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import {
  normalizeUsername,
  StaffPublicDto,
} from '../../staff/dto/staff.dto.js';
import { Permission } from '../../rbac/permissions.js';

export class LoginDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) => normalizeUsername(value))
  @IsString()
  @Length(3, 64)
  @Matches(/^[a-z0-9_.-]+$/)
  username: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(1, 128)
  password: string;
}
export class RefreshDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(1, 4096)
  refreshToken: string;
}
export class AuthResponseDto {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
  @ApiProperty({ example: 900 }) expiresIn: number;
  @ApiProperty({ format: 'date-time' }) refreshExpiresAt: Date;
  @ApiProperty({ type: StaffPublicDto }) staff: StaffPublicDto;
}
export class MeDto extends StaffPublicDto {
  @ApiProperty({ enum: Permission, isArray: true }) permissions: Permission[];
}
