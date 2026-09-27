import { Injectable, Optional } from '@nestjs/common';
import { ClusterBus } from '../cluster/cluster-bus.js';

// After-commit hint that new PENDING GameCommand work may exist (12.6B): to
// the local worker and, in MULTI, to the instance owning the Agent socket.
// Payload-free and best effort: the database queue and the owner-aware
// reservation stay the authority; a lost hint falls back to polling. It
// only announces work: nothing here can create or address a command.
@Injectable()
export class GameCommandWork {
  private readonly listeners = new Set<() => void>();
  constructor(@Optional() private readonly cluster?: ClusterBus) {}
  announce(): void {
    for (const listener of this.listeners) listener();
    void this.cluster?.publish('GAME_COMMAND_WORK', {});
  }
  onWork(listener: () => void): void {
    this.listeners.add(listener);
  }
}
