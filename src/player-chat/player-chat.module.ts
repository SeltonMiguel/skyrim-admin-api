import { PlayerSettingsModule } from '../player-settings/player-settings.module.js';
import { Module } from '@nestjs/common';
import { PlayerAuthModule } from '../player-auth/player-auth.module.js';
import { ChatRateLimiter } from './chat-rate-limiter.js';
import {
  CharacterChatController,
  GroupChatController,
  GuildChatController,
  PlayerChatController,
} from './player-chat.controller.js';
import { PlayerChatService } from './player-chat.service.js';

// Player chat: plain-text messages persisted with retention, delivered in
// realtime through the global event bus. No Audit per message (the row is
// the record), no Skyrim/Agent chat integration and no game command.
@Module({
  imports: [PlayerAuthModule, PlayerSettingsModule],
  providers: [PlayerChatService, ChatRateLimiter],
  controllers: [
    PlayerChatController,
    GroupChatController,
    GuildChatController,
    CharacterChatController,
  ],
})
export class PlayerChatModule {}
