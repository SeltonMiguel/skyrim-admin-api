import { ServerControlGateway } from '../../src/server-control/server-control-gateway.js';
import type {
  ServerControlAcceptance,
  ServerControlRequest,
} from '../../src/server-control/server-control-gateway.js';

export class MockServerControlGateway extends ServerControlGateway {
  sends: ServerControlRequest[] = [];
  responses: (ServerControlAcceptance | Error | 'HANG')[] = [];
  beforeSend?: (request: ServerControlRequest) => Promise<void>;
  reset(): void {
    this.sends = [];
    this.responses = [];
    this.beforeSend = undefined;
  }
  override async send(
    request: ServerControlRequest,
    signal: AbortSignal,
  ): Promise<ServerControlAcceptance> {
    this.sends.push(structuredClone(request));
    await this.beforeSend?.(request);
    const response = this.responses.shift() ?? { accepted: true };
    if (response instanceof Error) throw response;
    if (response === 'HANG')
      return new Promise((resolve) =>
        signal.addEventListener('abort', () =>
          resolve({ accepted: false, reason: 'UNAVAILABLE' }),
        ),
      );
    return response;
  }
}
