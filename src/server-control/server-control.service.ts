import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, In } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { idempotencyKey } from '../administrative-operations/administrative-command.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditOutcome, AuditResource } from '../audit/audit.types.js';
import type { AuthenticatedStaff } from '../auth/auth.types.js';
import { RequestContext } from '../common/request-context/request-context.service.js';
import { BridgeClock } from '../game-bridge/bridge-clock.js';
import { GameServerService } from '../game-bridge/game-server.service.js';
import { ServerControlOperation } from './entities/server-control-operation.entity.js';
import {
  isServerControlType,
  SERVER_CONTROL_POLICY,
  SERVER_CONTROL_TYPES,
  ServerControlStatus,
} from './server-control.contracts.js';
import type { ServerControlType } from './server-control.contracts.js';
import { ServerControlDispatcher } from './server-control-dispatcher.js';
import {
  serverControlDetail,
  serverControlReference,
} from './server-control.presenter.js';

const NOT_FOUND = 'Server control operation not found';
const IN_FLIGHT = 'Another server control operation is in progress';
const ACTIVE_KEY = 'server_control_operations_active_key';

@Injectable()
export class ServerControlService {
  constructor(
    private readonly database: DataSource,
    private readonly servers: GameServerService,
    private readonly audit: AuditService,
    private readonly dispatcher: ServerControlDispatcher,
    private readonly context: RequestContext,
    private readonly clock: BridgeClock,
  ) {}
  private repository() {
    return this.database.getRepository<ServerControlOperation>(
      'ServerControlOperation',
    );
  }
  async request(
    gameServerId: string,
    type: ServerControlType,
    key: unknown,
    auth: AuthenticatedStaff,
  ) {
    if (!isServerControlType(type)) throw new NotFoundException(NOT_FOUND);
    const { permission, auditAction } = SERVER_CONTROL_POLICY[type];
    if (!auth.permissions.includes(permission))
      throw new ForbiddenException('Missing required permissions');
    const idempotency = idempotencyKey(key);
    const actor = {
      id: auth.user.id,
      username: auth.user.username,
      displayName: auth.user.displayName,
      roleName: auth.user.roleName,
    };
    // Operation and Audit commit together; Audit failure rolls back the row.
    // At most one non-terminal operation per server: checked under the
    // server row lock, enforced by a partial unique index.
    const { operation, created } = await this.transact(async (manager) => {
      // Serializes requests per server; the unique key remains the authority.
      const server = await this.servers.get(gameServerId, manager, true);
      // The only server state the backend actually knows is its registry flag.
      if (!server.enabled) throw new ConflictException('Game server disabled');
      const repository = manager.getRepository<ServerControlOperation>(
        'ServerControlOperation',
      );
      // A replay of the same key returns its operation, even while it is
      // the one in flight. Any other request must wait for it to end.
      const replay = await repository.findOneBy({
        gameServerId,
        idempotencyKey: idempotency,
      });
      if (!replay && (await this.inFlight(manager, gameServerId)))
        throw new ConflictException(IN_FLIGHT);
      const id = randomUUID();
      await repository
        .createQueryBuilder()
        .insert()
        .values({
          id,
          gameServerId,
          type,
          status: ServerControlStatus.PENDING,
          idempotencyKey: idempotency,
          correlationId: randomUUID(),
          requestId: this.context.requestId ?? null,
          requestedByStaffId: auth.user.id,
          createdAt: this.clock.now(),
        })
        .onConflict(
          'ON CONSTRAINT server_control_operations_idempotency_key DO NOTHING',
        )
        .execute();
      const operation = await repository.findOneByOrFail({
        gameServerId,
        idempotencyKey: idempotency,
      });
      if (operation.type !== type)
        throw new ConflictException('Idempotency key conflicts with operation');
      const created = operation.id === id;
      if (created)
        await this.audit.record(
          {
            actor,
            action: auditAction,
            resourceType: AuditResource.SERVER_CONTROL,
            resourceId: operation.id,
            metadata: {
              gameServerId: operation.gameServerId,
              operationId: operation.id,
              correlationId: operation.correlationId,
              type: operation.type,
            },
            outcome: AuditOutcome.SUCCESS,
            statusCode: 202,
          },
          manager,
        );
      return { operation, created };
    });
    // After commit, with no transaction open; HTTP replays never re-dispatch.
    if (!created) return serverControlReference(operation);
    await this.dispatcher.dispatchSafely(operation.id);
    return serverControlReference(
      (await this.repository().findOneBy({ id: operation.id })) ?? operation,
    );
  }
  private async inFlight(
    manager: EntityManager,
    gameServerId: string,
  ): Promise<boolean> {
    return manager
      .getRepository<ServerControlOperation>('ServerControlOperation')
      .existsBy({
        gameServerId,
        status: In([
          ServerControlStatus.PENDING,
          ServerControlStatus.DISPATCHED,
        ]),
      });
  }
  private async transact<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      const driver = (
        error as { driverError?: { code?: string; constraint?: string } }
      ).driverError;
      if (driver?.code === '23505' && driver.constraint === ACTIVE_KEY)
        throw new ConflictException(IN_FLIGHT);
      throw error;
    }
  }
  async get(id: string, auth: AuthenticatedStaff) {
    // Roles without any Server Control grant learn nothing about existence.
    if (
      !SERVER_CONTROL_TYPES.some((type) =>
        auth.permissions.includes(SERVER_CONTROL_POLICY[type].permission),
      )
    )
      throw new ForbiddenException('Missing required permissions');
    const operation = await this.repository().findOneBy({ id });
    if (!operation) throw new NotFoundException(NOT_FOUND);
    if (
      !auth.permissions.includes(
        SERVER_CONTROL_POLICY[operation.type].permission,
      )
    )
      throw new ForbiddenException('Missing required permissions');
    return serverControlDetail(operation);
  }
}
