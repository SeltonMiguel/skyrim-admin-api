import type { Request } from 'express';
import type { PlayerActor } from '../actors/actor.contracts.js';
import type { Player } from '../player-accounts/entities/player.entity.js';

// No roles or permissions: player authorization is ownership-based.
export interface AuthenticatedPlayer {
  player: Player;
  sessionId: string;
  actor: PlayerActor;
}
// Separate request slot from the staff `auth` property.
export interface PlayerAuthRequest extends Request {
  playerAuth?: AuthenticatedPlayer;
}
