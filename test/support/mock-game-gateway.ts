import { GameGateway } from '../../src/game-bridge/game-gateway.js';
import type {
  GatewayConnection,
  TransportAcceptance,
} from '../../src/game-bridge/game-gateway.js';
import type { CommandEnvelope } from '../../src/game-bridge/command-contract.js';
import { BridgeClock } from '../../src/game-bridge/bridge-clock.js';

export class TestBridgeClock extends BridgeClock {
  private time = Date.parse('2026-09-19T14:00:00Z');
  override now(): Date {
    return new Date(this.time);
  }
  advance(ms: number): void {
    this.time += ms;
  }
}
export class MockGameGateway extends GameGateway {
  available = true;
  sends: { connection: GatewayConnection; envelope: CommandEnvelope }[] = [];
  responses: (TransportAcceptance | Error)[] = [];
  beforeSend?: () => Promise<void>;
  override async send(
    connection: GatewayConnection,
    envelope: CommandEnvelope,
    signal: AbortSignal,
  ): Promise<TransportAcceptance> {
    this.sends.push(structuredClone({ connection, envelope }));
    await this.beforeSend?.();
    if (signal.aborted) return { accepted: false, reason: 'TRANSIENT' };
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return (
      response ??
      (this.available
        ? { accepted: true }
        : { accepted: false, reason: 'UNAVAILABLE' })
    );
  }
}
