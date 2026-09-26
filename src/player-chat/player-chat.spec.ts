import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConfigService } from '@nestjs/config';
import { REALTIME_EVENT_TYPES } from '../realtime-events/realtime-event-bus.js';
import { AuditAction } from '../audit/audit.types.js';
import type { ApplicationConfig } from '../config/environment.js';
import { ChatRateLimiter } from './chat-rate-limiter.js';
import {
  CHAT_PAGE_DEFAULT_LIMIT,
  ChatChannel,
  chatMessage,
  MAX_CHAT_MESSAGE_LENGTH,
} from './player-chat.contracts.js';

const limiter = (count = 5, window = 10) =>
  new ChatRateLimiter({
    get: () => ({
      playerChat: {
        retention: 7 * 86400,
        rateLimitCount: count,
        rateLimitWindow: window,
      },
    }),
  } as unknown as ConfigService<{ application: ApplicationConfig }, true>);

describe('Chat contracts', () => {
  it('has four channels, a 500 code point limit and pages of 50', () => {
    expect(Object.values(ChatChannel)).toEqual([
      'GLOBAL',
      'GROUP',
      'GUILD',
      'DIRECT',
    ]);
    expect(MAX_CHAT_MESSAGE_LENGTH).toBe(500);
    expect(CHAT_PAGE_DEFAULT_LIMIT).toBe(50);
    expect(REALTIME_EVENT_TYPES).toContain('CHAT_MESSAGE_CREATED');
    // Sending is never audited; only the Staff hide (12.4) is.
    expect(
      Object.values(AuditAction).filter((a) => a.includes('CHAT_MESSAGE')),
    ).toEqual(['PLAYER_CHAT_MESSAGE_HIDDEN']);
  });
  it('accepts trimmed plain text counted in code points', () => {
    expect(chatMessage('  hello, world!  ')).toBe('hello, world!');
    expect(chatMessage('<script>alert(1)</script> **bold**')).toBe(
      '<script>alert(1)</script> **bold**',
    );
    expect(chatMessage('😀'.repeat(500))).toHaveLength(1000);
    expect(chatMessage('ação — ñ 日本語')).toBe('ação — ñ 日本語');
  });
  it('rejects empty, too long, controls, bidi spoofing and ill-formed text', () => {
    for (const value of [
      '',
      '   ',
      'x'.repeat(501),
      '😀'.repeat(501),
      'a\nb',
      'a\tb',
      'a\u0000b',
      'a\u0085b',
      `a${String.fromCharCode(0x202e)}b`,
      `a${String.fromCharCode(0x2066)}b`,
      `a${String.fromCharCode(0xfeff)}b`,
      'a\ud800b',
      'a\udc00',
      42,
      null,
      ['x'],
    ])
      expect(() => chatMessage(value)).toThrow('Invalid message');
  });
});

describe('Chat rate limiter', () => {
  it('allows the configured count per sliding window and reports Retry-After', () => {
    const rl = limiter(5, 10);
    for (let i = 0; i < 5; i++)
      expect(rl.acquire('p:c', `k${i}`, 1000 + i)).toEqual({ owner: true });
    expect(rl.acquire('p:c', 'k5', 2000)).toEqual({ retryAfter: 9 });
    // Other characters or players have their own budget.
    expect(rl.acquire('p:other', 'k5', 2000)).toEqual({ owner: true });
    // The oldest slot frees after the window.
    expect(rl.acquire('p:c', 'k5', 11_000)).toEqual({ owner: true });
  });
  it('shares a slot between retries of one key and frees failed sends', () => {
    const rl = limiter(2, 10);
    expect(rl.acquire('b', 'same', 0)).toEqual({ owner: true });
    for (let i = 0; i < 7; i++)
      expect(rl.acquire('b', 'same', i)).toEqual({ owner: false });
    expect(rl.acquire('b', 'other', 1)).toEqual({ owner: true });
    expect(rl.acquire('b', 'third', 2)).toEqual({ retryAfter: 10 });
    rl.release('b', 'other');
    expect(rl.acquire('b', 'third', 3)).toEqual({ owner: true });
    rl.reset();
    expect(rl.acquire('b', 'fourth', 4)).toEqual({ owner: true });
  });
});

describe('Chat boundaries', () => {
  const sources = globSync(fileURLToPath(new URL('./**/*.ts', import.meta.url)))
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => [file, readFileSync(file, 'utf8')] as const);
  it('uses no game commands, Agent chat, WebSocket library or Audit', () => {
    for (const [, source] of sources) {
      for (const [, module] of source.matchAll(/from '([^']+)'/g))
        expect(module).not.toMatch(
          /game-command|game-bridge\/game|\/audit\/|\/realtime\/|^ws$|socket\.io/,
        );
      expect(source).not.toMatch(/GameCommand|AuditService/);
    }
  });
  it('exposes no edit or delete endpoints', () => {
    const controller = sources.find(([file]) =>
      file.endsWith('player-chat.controller.ts'),
    )![1];
    expect(controller).not.toMatch(/@(Put|Patch|Delete)\(/);
  });
});
