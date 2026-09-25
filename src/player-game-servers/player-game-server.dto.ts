import { ApiProperty } from '@nestjs/swagger';
import { PageQueryDto } from '../admin-queries/dto/query.dto.js';
import { GameProcessState } from '../game-agent/agent-protocol.contracts.js';

export class PlayerGameServersQueryDto extends PageQueryDto {}
export class PlayerGameServerDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: [true] }) enabled: boolean;
  @ApiProperty({
    description: 'Authenticated Host Agent with a fresh persisted heartbeat.',
  })
  agentConnected: boolean;
  @ApiProperty({
    enum: GameProcessState,
    nullable: true,
    description:
      'null when the Agent is unavailable; remote server runtime, never the local PC.',
  })
  gameProcessState: GameProcessState | null;
  @ApiProperty({
    description:
      'Fresh Agent, RUNNING and SKSE ready; not a guarantee that a particular command is supported.',
  })
  gameReady: boolean;
}
export class PlayerGameServerPageDto {
  @ApiProperty({ type: PlayerGameServerDto, isArray: true })
  items: PlayerGameServerDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() totalPages: number;
}
