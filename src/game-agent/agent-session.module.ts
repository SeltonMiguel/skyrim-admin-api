import { Module } from '@nestjs/common';
import { AgentSessionRegistry } from './agent-session.registry.js';

// The single in-memory Host Agent session registry, shared by the Agent
// transport (GameAgentModule) and the Game Bridge gateway, without a module
// cycle between them.
@Module({
  providers: [AgentSessionRegistry],
  exports: [AgentSessionRegistry],
})
export class AgentSessionModule {}
