import { COMMAND_TYPES } from '../game-bridge/command-contract.js';
import type { CommandType } from '../game-bridge/command-contract.js';
import { COMMAND_KINDS } from '../game-bridge/command-kinds.js';
import type { ServerControlType } from '../server-control/server-control.contracts.js';

// Closed GameCommand capabilities of a Host Agent (11.2). They describe
// operational compatibility only: RBAC and ownership are decided by the
// backend before a command exists, and a capability never authorizes.
//
// - GAME_COMMAND_V1: speaks the COMMAND / COMMAND_ACK / COMMAND_RESULT
//   protocol of this version;
// - one capability per command type, named exactly as the CommandType;
// - COMMAND_DEDUP_V1: keeps a durable journal by commandId (RECEIVED ->
//   FORWARDED -> COMPLETED), never re-executes a COMPLETED command, replays
//   its result and reports UNCERTAIN when a prior effect cannot be proven.
//   Required for every MUTATION; QUERY types do not need it.
export const GAME_COMMAND_CAPABILITY = 'GAME_COMMAND_V1';
export const COMMAND_DEDUP_CAPABILITY = 'COMMAND_DEDUP_V1';

export function supportsCommand(
  capabilities: readonly string[],
  type: CommandType,
): boolean {
  return (
    capabilities.includes(GAME_COMMAND_CAPABILITY) &&
    capabilities.includes(type) &&
    (COMMAND_KINDS[type] === 'QUERY' ||
      capabilities.includes(COMMAND_DEDUP_CAPABILITY))
  );
}
export function supportedCommandTypes(
  capabilities: readonly string[],
): CommandType[] {
  return COMMAND_TYPES.filter((type) => supportsCommand(capabilities, type));
}

// Closed Server Control capabilities (11.3), also compatibility only:
// - SERVER_CONTROL_V1: speaks SERVER_CONTROL / SERVER_CONTROL_RESULT and
//   keeps the durable operation journal by operationId (RECEIVED ->
//   EXECUTING -> COMPLETED): never executes an operationId twice, refuses
//   after notAfter, replays the result after reconnects and reports
//   UNCERTAIN when an EXECUTING entry cannot be proven. The journal is part
//   of the protocol, not a separate capability: at-most-once needs it.
// - one capability per action, named exactly as the ServerControlType.
// The game runtime (RUNNING, SKSE) is never required: START must work with
// Skyrim stopped.
export const SERVER_CONTROL_CAPABILITY = 'SERVER_CONTROL_V1';
export function supportsServerControl(
  capabilities: readonly string[],
  type: ServerControlType,
): boolean {
  return (
    capabilities.includes(SERVER_CONTROL_CAPABILITY) &&
    capabilities.includes(type)
  );
}
