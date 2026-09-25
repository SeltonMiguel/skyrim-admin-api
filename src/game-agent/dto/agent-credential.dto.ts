import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { AgentCredentialStatus } from '../agent-credential.contracts.js';

export class AgentCredentialServerRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() gameServerId: string;
}
export class AgentCredentialRouteDto extends AgentCredentialServerRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() credentialId: string;
}
// No fields: the backend generates everything; any property is rejected.
export class EmptyAgentCredentialBodyDto {}
// Safe metadata: never the secret or its hash.
export class AgentCredentialDto {
  @ApiProperty({ format: 'uuid' }) credentialId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({ enum: AgentCredentialStatus }) status: AgentCredentialStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastUsedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
}
export class AgentCredentialListDto {
  @ApiProperty({ type: [AgentCredentialDto] }) items: AgentCredentialDto[];
}
export class CreatedAgentCredentialDto {
  @ApiProperty({ format: 'uuid' }) credentialId: string;
  @ApiProperty({ format: 'uuid' }) gameServerId: string;
  @ApiProperty({
    description:
      'Shown only in this response (256-bit, base64url). Store it in the Host Agent; the backend keeps only its SHA-256.',
  })
  credentialSecret: string;
  @ApiProperty({ enum: [AgentCredentialStatus.ACTIVE] })
  status: AgentCredentialStatus.ACTIVE;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}
