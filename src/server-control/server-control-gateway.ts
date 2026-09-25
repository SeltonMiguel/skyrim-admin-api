import { Injectable } from '@nestjs/common';
import type { ServerControlType } from './server-control.contracts.js';
// Closed, transport-neutral request for the Host Agent. No command text,
// arguments, paths, environment or credentials: the Agent maps the fixed
// type to its own supervised action.
export interface ServerControlRequest {
  operationId: string;
  gameServerId: string;
  // The session chosen at the claim; the request goes nowhere else.
  connectionId: string;
  type: ServerControlType;
  correlationId: string;
  requestedAt: string;
  // Claim time, and the instant after which the Agent must not execute.
  issuedAt: string;
  notAfter: string;
}
// UNAVAILABLE and REJECTED must only be returned when delivery definitely did
// not happen; anything ambiguous must throw or time out instead.
export type ServerControlAcceptance =
  { accepted: true } | { accepted: false; reason: 'UNAVAILABLE' | 'REJECTED' };
// Implementations must settle within 1 second and honor abort. The caller holds
// no database transaction or lock during send.
export abstract class ServerControlGateway {
  // The session that could receive this operation now (connectionId), or
  // null. Asked before the claim, so an absent or incompatible Agent never
  // makes an operation cross the delivery boundary.
  abstract target(gameServerId: string, type: ServerControlType): string | null;
  abstract send(
    request: ServerControlRequest,
    signal: AbortSignal,
  ): Promise<ServerControlAcceptance>;
}
// Explicit fallback without transport: never a target, nothing is delivered
// and nothing is reported as success. Production uses the Host Agent gateway.
@Injectable()
export class DisconnectedServerControlGateway extends ServerControlGateway {
  target(): string | null {
    return null;
  }
  async send(): Promise<ServerControlAcceptance> {
    return { accepted: false, reason: 'UNAVAILABLE' };
  }
}
