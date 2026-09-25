import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import type { ApplicationConfig } from '../../config/environment.js';
import { parseTrustProxy, requestClientIp } from './client-ip.js';
import type { TrustProxy } from './client-ip.js';

// The configured proxy trust, shared by Express (`trust proxy`, so
// request.ip) and the WebSocket upgrade handlers.
@Injectable()
export class ClientAddress {
  readonly trust: TrustProxy;
  constructor(config: ConfigService<{ application: ApplicationConfig }, true>) {
    this.trust = parseTrustProxy(
      config.get('application', { infer: true }).security.trustProxy,
    );
  }
  of(request: IncomingMessage): string {
    return requestClientIp(request, this.trust);
  }
}
