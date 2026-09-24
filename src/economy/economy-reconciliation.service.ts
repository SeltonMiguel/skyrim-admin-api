import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Currency } from './economy.contracts.js';
import type { SystemAccountKey } from './economy.contracts.js';

export interface AccountMismatch {
  accountId: string;
  balance: number;
  ledgerSum: number;
}
// Internal consistency checks (no HTTP route): every balance equals the sum
// of its entries and every transaction sums to zero with at least two legs.
@Injectable()
export class EconomyReconciliationService {
  constructor(private readonly database: DataSource) {}
  async accountMismatches(gameServerId?: string): Promise<AccountMismatch[]> {
    const rows: { id: string; balance: string; ledger_sum: string }[] =
      await this.database.query(
        `SELECT a.id, a.balance, coalesce(sum(e.amount), 0) AS ledger_sum
           FROM economy_accounts a
           LEFT JOIN economy_entries e ON e.account_id = a.id
          WHERE $1::uuid IS NULL OR a.game_server_id = $1::uuid
          GROUP BY a.id, a.balance
         HAVING a.balance <> coalesce(sum(e.amount), 0)`,
        [gameServerId ?? null],
      );
    return rows.map((r) => ({
      accountId: r.id,
      balance: Number(r.balance),
      ledgerSum: Number(r.ledger_sum),
    }));
  }
  async unbalancedTransactions(gameServerId?: string): Promise<string[]> {
    const rows: { id: string }[] = await this.database.query(
      `SELECT t.id
         FROM economy_transactions t
         LEFT JOIN economy_entries e ON e.transaction_id = t.id
        WHERE $1::uuid IS NULL OR t.game_server_id = $1::uuid
        GROUP BY t.id
       HAVING count(e.id) < 2 OR coalesce(sum(e.amount), 0) <> 0`,
      [gameServerId ?? null],
    );
    return rows.map((r) => r.id);
  }
  // Balance of one system account on every server (0 while it does not
  // exist), for the escrow checks of Trade and Marketplace.
  async systemBalances(
    systemKey: SystemAccountKey,
    currency: Currency = Currency.GOLD,
  ): Promise<Map<string, number>> {
    const rows: { server: string; balance: string }[] =
      await this.database.query(
        `SELECT s.id AS server, coalesce(a.balance, 0) AS balance
           FROM game_servers s
           LEFT JOIN economy_accounts a
             ON a.game_server_id = s.id AND a.currency = $1 AND a.owner_type = 'SYSTEM' AND a.system_key = $2`,
        [currency, systemKey],
      );
    return new Map(rows.map((r) => [r.server, Number(r.balance)]));
  }
}
