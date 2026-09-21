import { ConflictException } from '@nestjs/common';

export enum CommandStatus {
  PENDING = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
}
export type TerminalStatus =
  CommandStatus.SUCCEEDED | CommandStatus.FAILED | CommandStatus.TIMEOUT;
export const COMMAND_TRANSITIONS: Readonly<
  Record<CommandStatus, readonly CommandStatus[]>
> = {
  PENDING: [CommandStatus.DISPATCHED, CommandStatus.FAILED],
  DISPATCHED: [CommandStatus.ACKNOWLEDGED, CommandStatus.TIMEOUT],
  ACKNOWLEDGED: [
    CommandStatus.SUCCEEDED,
    CommandStatus.FAILED,
    CommandStatus.TIMEOUT,
  ],
  SUCCEEDED: [],
  FAILED: [],
  TIMEOUT: [],
};
export function isTerminal(status: CommandStatus): status is TerminalStatus {
  return COMMAND_TRANSITIONS[status].length === 0;
}
export function transition(
  command: { status: CommandStatus },
  next: CommandStatus,
): void {
  if (!COMMAND_TRANSITIONS[command.status].includes(next))
    throw new ConflictException('Invalid command transition');
  command.status = next;
}
export function canDispatch(status: CommandStatus): boolean {
  return (
    status === CommandStatus.PENDING || status === CommandStatus.DISPATCHED
  );
}
