import { ApiProperty } from '@nestjs/swagger';
import { CommandStatus } from '../../game-bridge/command-state.js';
import type { TerminalStatus } from '../../game-bridge/command-state.js';
import type { CommandType } from '../../game-bridge/command-contract.js';
import { ServerHealth } from '../server-health.js';

export class CurrentConnectionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty()
  externalConnectionId: string;
  @ApiProperty({ enum: ['CONNECTED', 'DISCONNECTED'] })
  status: 'CONNECTED' | 'DISCONNECTED';
  @ApiProperty({ type: String, nullable: true })
  bridgeVersion: string | null;
  @ApiProperty({ type: String, nullable: true })
  protocolVersion: string | null;
  @ApiProperty({ format: 'date-time' })
  connectedAt: Date;
  @ApiProperty({ format: 'date-time' })
  lastHeartbeatAt: Date;
}

export class ConnectionDto extends CurrentConnectionDto {
  @ApiProperty({ format: 'uuid' })
  gameServerId: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  disconnectedAt: Date | null;
  @ApiProperty({ enum: ['SUPERSEDED', 'STALE', 'REQUESTED'], nullable: true })
  disconnectReason: 'SUPERSEDED' | 'STALE' | 'REQUESTED' | null;
  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class GameServerDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty()
  code: string;
  @ApiProperty()
  name: string;
  @ApiProperty()
  enabled: boolean;
  @ApiProperty({
    enum: ServerHealth,
    description:
      'DISABLED takes precedence; heartbeat equality at the timeout is STALE.',
  })
  health: ServerHealth;
  @ApiProperty({ type: CurrentConnectionDto, nullable: true })
  currentConnection: CurrentConnectionDto | null;
  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class CommandListDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
  @ApiProperty({ format: 'uuid' })
  gameServerId: string;
  @ApiProperty({ enum: ['BRIDGE_PING'] })
  type: CommandType;
  @ApiProperty({ enum: CommandStatus })
  status: CommandStatus;
  @ApiProperty({ format: 'uuid' })
  correlationId: string;
  @ApiProperty({ type: String, nullable: true })
  requestId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestedByStaffId: string | null;
  @ApiProperty()
  dispatchAttempts: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastDispatchAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt: Date | null;
  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class BridgePingDataDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  nonce: string;
}

export class CommandResultDto {
  @ApiProperty({
    enum: [
      CommandStatus.SUCCEEDED,
      CommandStatus.FAILED,
      CommandStatus.TIMEOUT,
    ],
  })
  outcome: TerminalStatus;
  @ApiProperty({ type: BridgePingDataDto, nullable: true })
  result: BridgePingDataDto | null;
  @ApiProperty({ type: String, nullable: true })
  errorCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  errorMessage: string | null;
  @ApiProperty({ format: 'date-time' })
  receivedAt: Date;
}

export class CommandDetailDto extends CommandListDto {
  @ApiProperty({ type: BridgePingDataDto })
  payload: BridgePingDataDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  ackDeadlineAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  executionDeadlineAt: Date | null;
  @ApiProperty({ type: CommandResultDto, nullable: true })
  result: CommandResultDto | null;
}

export class PageDto {
  @ApiProperty()
  total: number;
  @ApiProperty()
  page: number;
  @ApiProperty()
  limit: number;
  @ApiProperty()
  totalPages: number;
}

export class ServerPageDto extends PageDto {
  @ApiProperty({ type: GameServerDto, isArray: true })
  items: GameServerDto[];
}

export class ConnectionPageDto extends PageDto {
  @ApiProperty({ type: ConnectionDto, isArray: true })
  items: ConnectionDto[];
}

export class CommandPageDto extends PageDto {
  @ApiProperty({ type: CommandListDto, isArray: true })
  items: CommandListDto[];
}

export class ServerCountsDto {
  @ApiProperty()
  total: number;
  @ApiProperty()
  enabled: number;
  @ApiProperty()
  disabled: number;
  @ApiProperty()
  online: number;
  @ApiProperty()
  stale: number;
  @ApiProperty()
  offline: number;
}

export class CommandStatusCountsDto {
  @ApiProperty()
  PENDING: number;
  @ApiProperty()
  DISPATCHED: number;
  @ApiProperty()
  ACKNOWLEDGED: number;
  @ApiProperty()
  SUCCEEDED: number;
  @ApiProperty()
  FAILED: number;
  @ApiProperty()
  TIMEOUT: number;
}

export class CommandCountsDto {
  @ApiProperty({
    enum: [24],
    description:
      'Commands created in the inclusive interval [generatedAt - 24 hours, generatedAt].',
  })
  windowHours: 24;
  @ApiProperty()
  total: number;
  @ApiProperty({ type: CommandStatusCountsDto })
  byStatus: CommandStatusCountsDto;
  @ApiProperty({ description: 'FAILED + TIMEOUT in the creation window.' })
  attentionRequired: number;
}

export class DashboardDto {
  @ApiProperty({ format: 'date-time' })
  generatedAt: Date;
  @ApiProperty({ type: ServerCountsDto })
  servers: ServerCountsDto;
  @ApiProperty({ type: CommandCountsDto })
  commands: CommandCountsDto;
}
