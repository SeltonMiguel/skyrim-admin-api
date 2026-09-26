import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import type { Metrics } from '../observability/metrics.js';
import { SERVER_CONTROL_POLICY } from './server-control.contracts.js';
import type {
  ServerControlErrorCode,
  ServerControlStatus,
  ServerControlType,
} from './server-control.contracts.js';

export interface ServerControlTerminal {
  operationId: string;
  gameServerId: string;
  type: ServerControlType;
  status: ServerControlStatus;
  errorCode: ServerControlErrorCode | null;
  completedAt: Date;
}
// STAFF_SERVER_CONTROL_UPDATED (11.6): published after the commit that made
// an operation terminal (SUCCEEDED, FAILED or UNCERTAIN, the status says
// which), only to Staff holding the permission its GET requires for that
// type. The fields of GET /server-control-operations/:id, never the Agent
// payload, correlation, claim or Idempotency-Key.
// Every terminal write also feeds the metrics (12.3): all three outcomes
// stay distinct, and UNCERTAIN has its own counter for alerting.
export function publishServerControl(
  events: RealtimeEventBus,
  operation: ServerControlTerminal,
  metrics?: Metrics,
): void {
  metrics?.controlTerminal.inc({
    type: operation.type,
    status: operation.status,
    error_code: operation.errorCode ?? 'none',
  });
  if (operation.status === 'UNCERTAIN')
    metrics?.controlUncertain.inc({ type: operation.type });
  events.publish(
    'STAFF_SERVER_CONTROL_UPDATED',
    {
      operationId: operation.operationId,
      gameServerId: operation.gameServerId,
      type: operation.type,
      status: operation.status,
      errorCode: operation.errorCode,
      completedAt: operation.completedAt.toISOString(),
    },
    { staffPermission: SERVER_CONTROL_POLICY[operation.type].permission },
  );
}
