import { BadRequestException } from '@nestjs/common';
import { commandJson } from '../game-bridge/command-json.js';
import { externalId, fields } from '../game-bridge/command-validation.js';
import { quantity } from '../character-management/character-validation.js';
import type { CharacterPayload } from '../character-management/character-command.contracts.js';

// Definitions only: no character target, command submission or reward execution.
export type VipReward =
  | ({ type: 'ITEM' } & Omit<
      CharacterPayload<'CHARACTER_ITEM_GIVE'>,
      'characterId'
    >)
  | ({ type: 'HORSE' } & Omit<
      CharacterPayload<'CHARACTER_HORSE_GIVE'>,
      'characterId'
    >)
  | ({ type: 'TITLE' } & Omit<
      CharacterPayload<'CHARACTER_TITLE_GIVE'>,
      'characterId'
    >)
  | ({ type: 'SPELL' } & Omit<
      CharacterPayload<'CHARACTER_SPELL_GIVE'>,
      'characterId'
    >);
export const MAX_PRICE_MINOR = 2147483647;
export const MAX_REWARDS = 20;
export const MAX_OFFER_BYTES = 32768;
export type VipCurrency = 'BRL';
// Who holds an entitlement to the offer (10.17): the account (PLAYER) or one
// character identity (CHARACTER). Explicit, never inferred from the code or
// name; offers from before 10.17 default to CHARACTER because every reward
// type (ITEM, HORSE, TITLE, SPELL) is a character gameplay benefit.
export enum VipEntitlementScope {
  PLAYER = 'PLAYER',
  CHARACTER = 'CHARACTER',
}
export const DEFAULT_ENTITLEMENT_SCOPE = VipEntitlementScope.CHARACTER;
export interface OfferContent {
  name: string;
  description: string;
  priceMinor: number;
  currency: VipCurrency;
  sortOrder: number;
  rewards: VipReward[];
  entitlementScope: VipEntitlementScope;
}
export interface NewOffer extends OfferContent {
  code: string;
  active: boolean;
}
export function offerCode(value: unknown): string {
  if (typeof value !== 'string')
    throw new BadRequestException('Invalid offer code');
  const code = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(code))
    throw new BadRequestException('Invalid offer code');
  return code;
}
export function offerText(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(value) ||
    (!empty && value.includes('\n'))
  )
    throw new BadRequestException('Invalid offer text');
  const text = value.trim();
  if (
    (!empty && !text) ||
    text.length > max ||
    Buffer.from(text, 'utf8').toString('utf8') !== text
  )
    throw new BadRequestException('Invalid offer text');
  return text;
}
export function offerInteger(value: unknown, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new BadRequestException('Invalid nonnegative integer');
  return value;
}
export function offerCurrency(value: unknown): VipCurrency {
  if (value !== 'BRL') throw new BadRequestException('Supported currency: BRL');
  return value;
}
export function offerActive(value: unknown): boolean {
  if (typeof value !== 'boolean')
    throw new BadRequestException('Invalid active state');
  return value;
}
export function offerScope(value: unknown): VipEntitlementScope {
  if (
    !Object.values(VipEntitlementScope).includes(value as VipEntitlementScope)
  )
    throw new BadRequestException(
      'Supported entitlement scopes: PLAYER, CHARACTER',
    );
  return value as VipEntitlementScope;
}
export function vipRewards(value: unknown): VipReward[] {
  const data = commandJson(value, MAX_OFFER_BYTES);
  if (!Array.isArray(data) || data.length < 1 || data.length > MAX_REWARDS)
    throw new BadRequestException('Expected 1–20 typed rewards');
  return data.map((value) => {
    const head = fields(
      value,
      ['type'],
      ['itemId', 'quantity', 'horseId', 'titleId', 'spellId'],
    );
    switch (head.type) {
      case 'ITEM': {
        const p = fields(value, ['type', 'itemId', 'quantity']);
        return {
          type: 'ITEM',
          itemId: externalId(p.itemId),
          quantity: quantity(p.quantity),
        };
      }
      case 'HORSE':
        return {
          type: 'HORSE',
          horseId: externalId(fields(value, ['type', 'horseId']).horseId),
        };
      case 'TITLE':
        return {
          type: 'TITLE',
          titleId: externalId(fields(value, ['type', 'titleId']).titleId),
        };
      case 'SPELL':
        return {
          type: 'SPELL',
          spellId: externalId(fields(value, ['type', 'spellId']).spellId),
        };
      default:
        throw new BadRequestException('Unsupported VIP reward type');
    }
  });
}
const parsers: {
  [K in keyof OfferContent]: (value: unknown) => OfferContent[K];
} = {
  name: (value) => offerText(value, 100),
  description: (value) => offerText(value, 2000, true),
  priceMinor: (value) => offerInteger(value, MAX_PRICE_MINOR),
  currency: offerCurrency,
  sortOrder: (value) => offerInteger(value, 1000000),
  rewards: vipRewards,
  entitlementScope: offerScope,
};
export function newOffer(value: unknown): NewOffer {
  const data = fields(
    commandJson(value, MAX_OFFER_BYTES),
    ['code', 'name', 'description', 'priceMinor', 'currency', 'rewards'],
    ['active', 'sortOrder', 'entitlementScope'],
  );
  return {
    code: offerCode(data.code),
    name: parsers.name(data.name),
    description: parsers.description(data.description),
    priceMinor: parsers.priceMinor(data.priceMinor),
    currency: offerCurrency(data.currency),
    rewards: vipRewards(data.rewards),
    sortOrder:
      data.sortOrder === undefined ? 0 : parsers.sortOrder(data.sortOrder),
    active: data.active === undefined ? false : offerActive(data.active),
    entitlementScope:
      data.entitlementScope === undefined
        ? DEFAULT_ENTITLEMENT_SCOPE
        : offerScope(data.entitlementScope),
  };
}
export function offerPatch(value: unknown): Partial<OfferContent> {
  const data = fields(
    commandJson(value, MAX_OFFER_BYTES),
    [],
    Object.keys(parsers),
  );
  if (!Object.keys(data).length)
    throw new BadRequestException('At least one offer field is required');
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      parsers[key as keyof OfferContent](value),
    ]),
  );
}
