import { ExpressAdapter } from '@nestjs/platform-express';

export class AppExpressAdapter extends ExpressAdapter {
  override setNotFoundHandler(
    handler: Parameters<ExpressAdapter['setNotFoundHandler']>[0],
  ) {
    // Nest 12 scopes the fallback to the global prefix for shared adapters.
    // This server hosts one app, so all unmatched URLs must reach its filter.
    return super.setNotFoundHandler(handler);
  }
}
