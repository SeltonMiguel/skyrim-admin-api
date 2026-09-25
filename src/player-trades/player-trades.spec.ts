import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REALTIME_EVENT_TYPES } from '../realtime-events/realtime-event-bus.js';
import { SystemAccountKey } from '../economy/economy.contracts.js';
import {
  EscrowStatus,
  MAX_TRADE_ITEM_LINES,
  MAX_TRADE_ITEM_QUANTITY,
  otherSide,
  SettlementOutcome,
  TERMINAL_TRADE_STATUSES,
  TradeAssetType,
  TradeSide,
  TradeStatus,
} from './player-trade.contracts.js';

describe('Trade contracts', () => {
  it('has a closed lifecycle with three terminal states', () => {
    expect(Object.values(TradeStatus)).toEqual([
      'NEGOTIATING',
      'AWAITING_GAME_CONFIRMATION',
      'COMPLETED',
      'CANCELLED',
      'FAILED',
    ]);
    expect(TERMINAL_TRADE_STATUSES).toEqual([
      'COMPLETED',
      'CANCELLED',
      'FAILED',
    ]);
    expect(Object.values(EscrowStatus)).toEqual([
      'RESERVED',
      'RELEASED',
      'SETTLED',
    ]);
    expect(Object.values(SettlementOutcome)).toEqual(['SETTLED', 'FAILED']);
    expect(Object.values(TradeAssetType)).toEqual([
      'LEDGER_CURRENCY',
      'GAME_ITEM',
    ]);
  });
  it('keeps limits centralized and sides symmetric', () => {
    expect(MAX_TRADE_ITEM_LINES).toBe(20);
    expect(MAX_TRADE_ITEM_QUANTITY).toBe(10_000);
    expect(otherSide(TradeSide.INITIATOR)).toBe(TradeSide.TARGET);
    expect(otherSide(TradeSide.TARGET)).toBe(TradeSide.INITIATOR);
    expect(Object.values(SystemAccountKey)).toContain('TRADE_ESCROW');
  });
  it('publishes typed trade events through the shared bus', () => {
    expect(REALTIME_EVENT_TYPES.filter((t) => t.startsWith('TRADE_'))).toEqual([
      'TRADE_CREATED',
      'TRADE_OFFER_UPDATED',
      'TRADE_ACCEPTED',
      'TRADE_AWAITING_GAME_CONFIRMATION',
      'TRADE_COMPLETED',
      'TRADE_CANCELLED',
      'TRADE_FAILED',
    ]);
  });
});

describe('Trade boundaries', () => {
  const sources = globSync(fileURLToPath(new URL('./**/*.ts', import.meta.url)))
    .filter((file) => !file.endsWith('.spec.ts'))
    .map((file) => [file, readFileSync(file, 'utf8')] as const);
  it('never settles through game commands or staff item mutations', () => {
    for (const [, source] of sources) {
      for (const [, module] of source.matchAll(/from '([^']+)'/g))
        expect(module).not.toMatch(
          /game-command|character-management|player-character-operations|administrative-operations|\/realtime\/|^ws$/,
        );
      expect(source).not.toMatch(
        /CHARACTER_ITEM_GIVE|CHARACTER_INVENTORY_REMOVE_ITEM|GameCommand/,
      );
    }
  });
  it('exposes the Agent settlement only as an internal service', () => {
    const controller = sources.find(([file]) =>
      file.endsWith('player-trade.controller.ts'),
    )![1];
    expect(controller).not.toMatch(
      /confirmFromAgent|settle|SettlementService/i,
    );
  });
});
