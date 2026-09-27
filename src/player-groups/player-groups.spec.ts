import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import type { DataSource } from 'typeorm';
import type { AuditService } from '../audit/audit.service.js';
import type { PlayerSettingsService } from '../player-settings/player-settings.service.js';
import { RealtimeEventBus } from '../realtime-events/realtime-event-bus.js';
import { PlayerGroupService } from './player-group.service.js';

// F-DB4 (12.7B): the row locks serialize every insert path, so a unique
// violation is residual; if one ever surfaces it is a 409, never a 500.
describe('Group unique violations', () => {
  const mutate = (error: unknown) => {
    const groups = new PlayerGroupService(
      {
        transaction: () => Promise.reject(error),
      } as unknown as DataSource,
      {} as AuditService,
      new RealtimeEventBus(),
      {} as PlayerSettingsService,
      {
        get: () => ({ playerGroups: { inviteTtl: 60 } }),
      } as unknown as ConfigService<never, true>,
    );
    return (
      groups as unknown as { mutate: (work: unknown) => Promise<unknown> }
    ).mutate(() => undefined);
  };
  const violation = (code: string, constraint: string) =>
    new QueryFailedError('INSERT', [], { code, constraint } as never);

  it.each([
    ['player_group_members_active_key', 'Character already in a group'],
    ['player_group_members_leader_key', 'Group leader conflict'],
    ['player_group_invites_pending_key', 'Group invite already pending'],
  ])('maps %s to a 409', async (constraint, message) => {
    await expect(mutate(violation('23505', constraint))).rejects.toEqual(
      new ConflictException(message),
    );
  });
  it('leaves unknown constraints and other errors untouched', async () => {
    const unknown = violation('23505', 'other_key');
    await expect(mutate(unknown)).rejects.toBe(unknown);
    const foreign = violation('23503', 'player_group_members_active_key');
    await expect(mutate(foreign)).rejects.toBe(foreign);
  });
});
