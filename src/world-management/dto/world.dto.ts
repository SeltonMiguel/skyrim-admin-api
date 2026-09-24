import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsNumber, IsString, IsUUID, Max, Min } from 'class-validator';
import { externalId } from '../../game-bridge/command-validation.js';
import { gameHour, MAX_SPAWN_QUANTITY } from '../world-command.contracts.js';
export class WorldServerRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() serverId: string;
}
export class EmptyWorldBodyDto {}
export class WorldTimeBodyDto {
  @ApiProperty({
    minimum: 0,
    maximum: 24,
    exclusiveMaximum: true,
    description: 'Explicit SET of game hour in [0, 24).',
  })
  @Transform(({ value }: { value: unknown }) => gameHour(value))
  @IsNumber({ allowNaN: false, allowInfinity: false })
  gameHour: number;
}
export class WorldWeatherBodyDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: 'Opaque, trimmed identifier; no control characters.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  weatherId: string;
}
export class WorldSpawnBodyDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    description: 'Opaque identifier; spawned near the authenticated staff.',
  })
  @Transform(({ value }: { value: unknown }) => externalId(value))
  @IsString()
  baseFormId: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: MAX_SPAWN_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_SPAWN_QUANTITY)
  quantity: number;
}
