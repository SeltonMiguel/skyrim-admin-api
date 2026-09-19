import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

export interface HttpRequestContext {
  method: string;
  path: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<{
    requestId: string;
    http?: HttpRequestContext;
  }>();

  run(
    requestId: string,
    callback: () => void,
    http?: HttpRequestContext,
  ): void {
    this.storage.run(
      { requestId, http: http ? { ...http } : undefined },
      callback,
    );
  }

  get http(): Readonly<HttpRequestContext> | undefined {
    const http = this.storage.getStore()?.http;
    return http ? { ...http } : undefined;
  }

  get requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }
}
