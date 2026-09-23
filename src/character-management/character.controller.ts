import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { RequirePermissions } from '../rbac/require-permissions.decorator.js';
import { Permission as P } from '../rbac/permissions.js';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { HttpErrorDto } from '../common/filters/http-error.dto.js';
import { CharacterService, idempotencyKey } from './character.service.js';
import {
  CharacterRouteDto,
  CharacterQueryBodyDto,
  ItemBodyDto,
  PropertyBodyDto,
  HoldBodyDto,
  HorseBodyDto,
  TitleBodyDto,
  SpellBodyDto,
  FactionBodyDto,
} from './dto/character.dto.js';
import {
  CharacterOperationDetailDto,
  CharacterOperationReferenceDto,
} from './dto/operation.dto.js';

// Method-level responses retain Location when Swagger infers the @HttpCode status.
function ApiCharacterAcceptedResponse() {
  return ApiAcceptedResponse({
    type: CharacterOperationReferenceDto,
    description:
      'Accepted and persisted, not execution success. Poll Location for the result.',
    headers: {
      Location: {
        schema: { type: 'string' },
        description: '/api/v1/character-operations/{commandId}',
      },
    },
  });
}

@ApiTags('character-management')
@ApiBearerAuth()
@ApiHeader({
  name: 'Idempotency-Key',
  required: true,
  description:
    '1–128 ASCII letters, digits or ._:-. Same server/key/type/payload replays the existing operation.',
})
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@ApiConflictResponse({ type: HttpErrorDto })
@ApiServiceUnavailableResponse({
  type: HttpErrorDto,
  description: 'Audit unavailable; mutation command rolled back.',
})
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({
  path: 'game-servers/:serverId/characters/:characterId',
  version: '1',
})
export class CharacterController {
  constructor(private readonly operations: CharacterService) {}
  private async accepted(
    operation: Promise<CharacterOperationReferenceDto>,
    response: Response,
  ) {
    const reference = await operation;
    response.setHeader(
      'Location',
      `/api/v1/character-operations/${reference.commandId}`,
    );
    return reference;
  }
  @Post('inventory/query')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_INVENTORY_READ)
  @ApiOperation({
    summary: 'CHARACTER_INVENTORY_QUERY',
    description:
      'Requires CHARACTER_INVENTORY_READ. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  inventory_query(
    @Param() route: CharacterRouteDto,
    @Body() body: CharacterQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_INVENTORY_QUERY',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('inventory/items/remove')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_INVENTORY_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_INVENTORY_REMOVE_ITEM',
    description:
      'Requires CHARACTER_INVENTORY_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  inventory_remove_item(
    @Param() route: CharacterRouteDto,
    @Body() body: ItemBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_INVENTORY_REMOVE_ITEM',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('inventory/items/give')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_ITEM_GIVE)
  @ApiOperation({
    summary: 'CHARACTER_ITEM_GIVE',
    description:
      'Requires CHARACTER_ITEM_GIVE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  item_give(
    @Param() route: CharacterRouteDto,
    @Body() body: ItemBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_ITEM_GIVE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('properties/query')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_PROPERTY_READ)
  @ApiOperation({
    summary: 'CHARACTER_PROPERTIES_QUERY',
    description:
      'Requires CHARACTER_PROPERTY_READ. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  properties_query(
    @Param() route: CharacterRouteDto,
    @Body() body: CharacterQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_PROPERTIES_QUERY',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('properties/grant')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_PROPERTY_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_PROPERTY_GRANT',
    description:
      'Requires CHARACTER_PROPERTY_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  property_grant(
    @Param() route: CharacterRouteDto,
    @Body() body: PropertyBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_PROPERTY_GRANT',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('properties/revoke')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_PROPERTY_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_PROPERTY_REVOKE',
    description:
      'Requires CHARACTER_PROPERTY_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  property_revoke(
    @Param() route: CharacterRouteDto,
    @Body() body: PropertyBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_PROPERTY_REVOKE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('holds/query')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_HOLD_READ)
  @ApiOperation({
    summary: 'CHARACTER_HOLDS_QUERY',
    description:
      'Requires CHARACTER_HOLD_READ. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  holds_query(
    @Param() route: CharacterRouteDto,
    @Body() body: CharacterQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_HOLDS_QUERY',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('holds/grant')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_HOLD_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_HOLD_GRANT',
    description:
      'Requires CHARACTER_HOLD_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  hold_grant(
    @Param() route: CharacterRouteDto,
    @Body() body: HoldBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_HOLD_GRANT',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('holds/revoke')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_HOLD_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_HOLD_REVOKE',
    description:
      'Requires CHARACTER_HOLD_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  hold_revoke(
    @Param() route: CharacterRouteDto,
    @Body() body: HoldBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_HOLD_REVOKE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('horses/query')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_HORSE_READ)
  @ApiOperation({
    summary: 'CHARACTER_HORSES_QUERY',
    description:
      'Requires CHARACTER_HORSE_READ. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  horses_query(
    @Param() route: CharacterRouteDto,
    @Body() body: CharacterQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_HORSES_QUERY',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('horses/give')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_HORSE_GIVE)
  @ApiOperation({
    summary: 'CHARACTER_HORSE_GIVE',
    description:
      'Requires CHARACTER_HORSE_GIVE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  horse_give(
    @Param() route: CharacterRouteDto,
    @Body() body: HorseBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_HORSE_GIVE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('horses/revoke')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_HORSE_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_HORSE_REVOKE',
    description:
      'Requires CHARACTER_HORSE_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  horse_revoke(
    @Param() route: CharacterRouteDto,
    @Body() body: HorseBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_HORSE_REVOKE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('titles/give')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_TITLE_GIVE)
  @ApiOperation({
    summary: 'CHARACTER_TITLE_GIVE',
    description:
      'Requires CHARACTER_TITLE_GIVE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  title_give(
    @Param() route: CharacterRouteDto,
    @Body() body: TitleBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_TITLE_GIVE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('spells/give')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.CHARACTER_SPELL_GIVE)
  @ApiOperation({
    summary: 'CHARACTER_SPELL_GIVE',
    description:
      'Requires CHARACTER_SPELL_GIVE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  spell_give(
    @Param() route: CharacterRouteDto,
    @Body() body: SpellBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_SPELL_GIVE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('factions/query')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.FACTION_READ)
  @ApiOperation({
    summary: 'CHARACTER_FACTIONS_QUERY',
    description:
      'Requires FACTION_READ. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  factions_query(
    @Param() route: CharacterRouteDto,
    @Body() body: CharacterQueryBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_FACTIONS_QUERY',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('factions/add')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.FACTION_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_FACTION_ADD',
    description:
      'Requires FACTION_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  faction_add(
    @Param() route: CharacterRouteDto,
    @Body() body: FactionBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_FACTION_ADD',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
  @Post('factions/remove')
  @HttpCode(202)
  @ApiCharacterAcceptedResponse()
  @RequirePermissions(P.FACTION_WRITE)
  @ApiOperation({
    summary: 'CHARACTER_FACTION_REMOVE',
    description:
      'Requires FACTION_WRITE. Asynchronous: 202 means accepted/persisted, not Skyrim execution success.',
  })
  faction_remove(
    @Param() route: CharacterRouteDto,
    @Body() body: FactionBodyDto,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentStaff() auth: AuthenticatedStaff,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.accepted(
      this.operations.create(
        {
          gameServerId: route.serverId,
          type: 'CHARACTER_FACTION_REMOVE',
          payload: { characterId: route.characterId, ...body },
          idempotencyKey: idempotencyKey(key),
        },
        auth,
      ),
      response,
    );
  }
}
@ApiTags('character-management')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: HttpErrorDto })
@ApiUnauthorizedResponse({ type: HttpErrorDto })
@ApiForbiddenResponse({ type: HttpErrorDto })
@ApiNotFoundResponse({ type: HttpErrorDto })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller({ path: 'character-operations', version: '1' })
export class CharacterOperationController {
  constructor(private readonly operations: CharacterService) {}
  @Get(':commandId')
  @ApiOperation({
    summary: 'Read a character operation and its typed result.',
    description:
      'Requires the same Character permission as the POST that created this command type; GAME_BRIDGE_READ alone is insufficient. Non-Character commands return 404.',
  })
  @ApiOkResponse({ type: CharacterOperationDetailDto })
  get(
    @Param('commandId', new ParseUUIDPipe()) id: string,
    @CurrentStaff() auth: AuthenticatedStaff,
  ) {
    return this.operations.get(id, auth);
  }
}
