import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsString, Length, Matches } from 'class-validator';
import { RoleName } from '../../rbac/roles.js';
import { StaffStatus } from '../entities/staff-user.entity.js';

export const normalizeUsername = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trim = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class StaffProfileDto {
  @ApiProperty({ minLength: 3, maxLength: 64, pattern: '^[a-z0-9_.-]+$' })
  @Transform(({ value }: { value: unknown }) => normalizeUsername(value))
  @IsString()
  @Length(3, 64)
  @Matches(/^[a-z0-9_.-]+$/)
  username: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsString()
  @Length(1, 100)
  displayName: string;
}

export class CreateStaffDto extends StaffProfileDto {
  @ApiProperty({ minLength: 12, maxLength: 128, writeOnly: true })
  @IsString()
  @Length(12, 128)
  @Matches(/\S/, { message: 'password must not contain only whitespace' })
  password: string;

  @ApiProperty({ enum: RoleName })
  @IsEnum(RoleName)
  role: RoleName;
}

export class UpdateStaffDto extends PartialType(StaffProfileDto, {
  skipNullProperties: false,
}) {}
export class UpdateRoleDto {
  @ApiProperty({ enum: RoleName })
  @IsEnum(RoleName)
  role: RoleName;
}
export class UpdateStatusDto {
  @ApiProperty({ enum: StaffStatus })
  @IsEnum(StaffStatus)
  status: StaffStatus;
}

export class StaffPublicDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() username: string;
  @ApiProperty() displayName: string;
  @ApiProperty({ enum: RoleName }) role: RoleName;
  @ApiProperty({ enum: StaffStatus }) status: StaffStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt: Date | null;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}
