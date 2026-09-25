import { HttpException, HttpStatus } from '@nestjs/common';

// Generic 429: the body never says which bucket was exhausted; the global
// filter turns retryAfter into a Retry-After header.
export class TooManyRequestsException extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
  }
}
