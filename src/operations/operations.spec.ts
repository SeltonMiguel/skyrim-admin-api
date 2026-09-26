import 'reflect-metadata';
import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { PermissionGuard } from '../rbac/permission.guard.js';
import { Permission as P } from '../rbac/permissions.js';
import { REQUIRED_PERMISSIONS } from '../rbac/require-permissions.decorator.js';
import { AgentWorkNotifier } from '../game-agent/agent-work.notifier.js';
import { RealtimeSessionControl } from '../realtime-events/realtime-session-control.js';
import { RealtimeConnectionRegistry } from '../realtime/realtime-connection.registry.js';
import {
  deliveryIdempotencyKey,
  PRE_EFFECT_COMMAND_ERRORS,
} from '../vip-entitlements/vip-delivery.contracts.js';
import { COMMAND_ERRORS } from '../game-bridge/game-command-store.js';
import { OperationsController } from './operations.controller.js';
import {
  DOMAIN_PERMISSION,
  metricAction,
  metricDomain,
  OperatorActionKind,
  OperatorDomain,
} from './operations.contracts.js';
import { deliveryEvidence } from './recovery.service.js';

describe('Operational recovery contracts (12.4)', () => {
  it('maps every domain to one narrow recovery permission', () => {
    expect(Object.keys(DOMAIN_PERMISSION).sort()).toEqual(
      Object.values(OperatorDomain).sort(),
    );
    expect(Object.values(DOMAIN_PERMISSION)).not.toEqual(
      expect.arrayContaining([
        P.SERVER_START,
        P.SERVER_RESTART,
        P.GAME_BRIDGE_READ,
        P.DASHBOARD_READ,
        P.STAFF_WRITE,
      ]),
    );
  });
  it('uses closed lowercase metric labels', () => {
    for (const domain of Object.values(OperatorDomain))
      expect(metricDomain(domain)).toMatch(/^[a-z_]+$/);
    for (const action of Object.values(OperatorActionKind))
      expect(metricAction(action)).toMatch(/^[a-z_]+$/);
  });
  it('keeps the attempt-1 VIP key of 11.4 and gives each new attempt its own', () => {
    expect(deliveryIdempotencyKey('d')).toBe('vip-delivery:d');
    expect(deliveryIdempotencyKey('d', 1)).toBe('vip-delivery:d');
    expect(deliveryIdempotencyKey('d', 2)).toBe('vip-delivery:d:2');
  });
  it('treats as pre-effect only codes the dispatcher sets before any delivery', () => {
    for (const code of PRE_EFFECT_COMMAND_ERRORS)
      expect(Object.keys(COMMAND_ERRORS)).toContain(code);
    for (const code of [
      'EXECUTION_FAILED',
      'BRIDGE_ERROR',
      'EXECUTION_UNCERTAIN',
      'ACK_TIMEOUT',
      'EXECUTION_TIMEOUT',
    ])
      expect(PRE_EFFECT_COMMAND_ERRORS as readonly string[]).not.toContain(
        code,
      );
  });
  it('classifies delivery evidence from the command, never from the delivery alone', () => {
    const failed = { status: 'FAILED', gameCommandId: 'c' } as never;
    expect(
      deliveryEvidence(failed, {
        status: 'FAILED',
        error_code: 'DISPATCH_EXPIRED',
      }),
    ).toBe('PRE_EFFECT_FAILURE');
    expect(
      deliveryEvidence(failed, {
        status: 'FAILED',
        error_code: 'EXECUTION_FAILED',
      }),
    ).toBe('POSSIBLY_EXECUTED');
    // A pre-effect code on a TIMEOUT command proves nothing.
    expect(
      deliveryEvidence(failed, {
        status: 'TIMEOUT',
        error_code: 'DISPATCH_EXPIRED',
      }),
    ).toBe('POSSIBLY_EXECUTED');
    expect(
      deliveryEvidence({ status: 'UNCERTAIN', gameCommandId: 'c' } as never, {
        status: 'FAILED',
        error_code: 'DISPATCH_EXPIRED',
      }),
    ).toBe('POSSIBLY_EXECUTED');
    expect(deliveryEvidence(failed, undefined)).toBe('POSSIBLY_EXECUTED');
    expect(
      deliveryEvidence(
        { status: 'FAILED', gameCommandId: null } as never,
        undefined,
      ),
    ).toBe('NO_COMMAND');
  });
});

describe('Operational recovery routes', () => {
  const routes = Object.getOwnPropertyNames(OperationsController.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (
        OperationsController.prototype as unknown as Record<string, object>
      )[name];
      return {
        name,
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
        permissions: Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as
          P[] | undefined,
      };
    });
  it('are Staff JWT + fail-closed RBAC, each with exactly one permission', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OperationsController)).toEqual([
      JwtAuthGuard,
      PermissionGuard,
    ]);
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) expect(route.permissions).toHaveLength(1);
  });
  it('mutate only through the operator action model (POST with a reason)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./operations.controller.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/@(Put|Patch|Delete)\(/);
    for (const route of routes.filter((r) => r.method === RequestMethod.POST))
      expect(route.permissions![0]).not.toBe(P.OPERATIONS_READ);
  });
  it('never create GameCommands, Server Control operations or raw balances', () => {
    const sources = globSync(
      fileURLToPath(new URL('./**/*.ts', import.meta.url)),
    )
      .filter((file) => !file.endsWith('.spec.ts'))
      .map((file) =>
        readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      );
    for (const source of sources) {
      expect(source).not.toMatch(
        /game-command-bus|submitInTransaction|ServerControlService|server-control-dispatcher|console\.|child_process/,
      );
      expect(source).not.toMatch(/UPDATE economy_accounts|SET balance/i);
      expect(source).not.toMatch(/DELETE FROM/i);
    }
  });
});

describe('Recovery transport hooks', () => {
  it('forgets a pushed work item on every connection, and nothing else', () => {
    const notifier = Object.create(
      AgentWorkNotifier.prototype,
    ) as AgentWorkNotifier;
    const told = new Map([
      ['c1', new Set(['TRADE_SETTLEMENT:w1', 'TRADE_SETTLEMENT:w2'])],
      ['c2', new Set(['TRADE_SETTLEMENT:w1'])],
    ]);
    Object.assign(notifier, { told });
    expect(notifier.forget('TRADE_SETTLEMENT', 'w1')).toBe(2);
    expect([...told.get('c1')!]).toEqual(['TRADE_SETTLEMENT:w2']);
    expect(notifier.forget('MARKETPLACE_RELEASE', 'w2')).toBe(0);
  });
  it('signals account revocation to its listeners, isolating failures', () => {
    const control = new RealtimeSessionControl();
    const seen: unknown[] = [];
    control.subscribeAccounts(() => {
      throw new Error('boom');
    });
    const off = control.subscribeAccounts((playerId, sessions) =>
      seen.push([playerId, sessions]),
    );
    control.playerAccountRevoked('p', ['s1', 's2']);
    off();
    control.playerAccountRevoked('p', []);
    expect(seen).toEqual([['p', ['s1', 's2']]]);
  });
  it('closes every socket of one identity only', () => {
    const registry = new RealtimeConnectionRegistry();
    type Stub = { OPEN: number; readyState: number; closed: unknown };
    const socket = (): Stub => {
      const stub: Stub & { close(code: number, reason: string): void } = {
        OPEN: 1,
        readyState: 1,
        closed: null,
        close(code, reason) {
          stub.closed = [code, reason];
        },
      };
      return stub;
    };
    const [a, b, other] = [socket(), socket(), socket()];
    registry.add('PLAYER:p', a as never, 's1');
    registry.add('PLAYER:p', b as never, 's2');
    registry.add('PLAYER:q', other as never, 's3');
    expect(registry.closeKey('PLAYER:p', 4001, 'ACCOUNT_DISABLED')).toBe(2);
    expect([a.closed, b.closed, other.closed]).toEqual([
      [4001, 'ACCOUNT_DISABLED'],
      [4001, 'ACCOUNT_DISABLED'],
      null,
    ]);
    expect(registry.count('PLAYER:p')).toBe(0);
    expect(registry.sessionCount('s1')).toBe(0);
    expect(registry.count('PLAYER:q')).toBe(1);
  });
});
