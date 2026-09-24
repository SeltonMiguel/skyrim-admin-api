import { Injectable } from '@nestjs/common';
import type { ServerControlType } from './server-control.contracts.js';

// Closed, transport-neutral request for the future Agent (Etapa 11). No command
// text, arguments, paths, environment or credentials: the Agent maps the fixed
// type to its own supervised action.
export interface ServerControlRequest {
  operationId: string;
  gameServerId: string;
  type: ServerControlType;
  correlationId: string;
  requestedAt: string;
}
// UNAVAILABLE and REJECTED must only be returned when delivery definitely did
// not happen; anything ambiguous must throw or time out instead.
export type ServerControlAcceptance =
  { accepted: true } | { accepted: false; reason: 'UNAVAILABLE' | 'REJECTED' };
// Implementations must settle within 1 second and honor abort. The caller holds
// no database transaction or lock during send.
export abstract class ServerControlGateway {
  abstract send(
    request: ServerControlRequest,
    signal: AbortSignal,
  ): Promise<ServerControlAcceptance>;
}
// Production default until an Agent transport exists: nothing is delivered and
// nothing is reported as success.
@Injectable()
export class DisconnectedServerControlGateway extends ServerControlGateway {
  async send(): Promise<ServerControlAcceptance> {
    return { accepted: false, reason: 'UNAVAILABLE' };
  }
}
