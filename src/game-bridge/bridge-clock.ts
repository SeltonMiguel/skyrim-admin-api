import { Injectable } from '@nestjs/common';
@Injectable()
export class BridgeClock {
  now(): Date {
    return new Date();
  }
}
