import { Injectable } from '@nestjs/common';
import type { CommandEnvelope } from './command-contract.js';

export interface GatewayConnection {
  id: string;
  gameServerId: string;
  externalConnectionId: string;
}
export type TransportAcceptance =
  | { accepted: true }
  | {
      accepted: false;
      reason: 'UNAVAILABLE' | 'TRANSIENT' | 'PERMANENT';
    };
// Implementations must settle within 1 second and honor abort before further sends.
// No database transaction is held by the caller; ACK/RESULT may arrive during send.
export abstract class GameGateway {
  abstract send(
    connection: GatewayConnection,
    envelope: CommandEnvelope,
    signal: AbortSignal,
  ): Promise<TransportAcceptance>;
}
@Injectable()
export class DisconnectedGameGateway extends GameGateway {
  async send(): Promise<TransportAcceptance> {
    return { accepted: false, reason: 'UNAVAILABLE' };
  }
}
