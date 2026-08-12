import BigNumber from 'bignumber.js';
import { Transaction } from 'sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxType } from '../db/models/walletTx';
import { AppError } from '../lib/errors';
import { dec, money, ZERO } from '../lib/money';

/**
 * The single place a wallet balance is allowed to change.
 *
 * Concurrency model: pessimistic row locking. Every balance change takes
 * `SELECT ... FOR UPDATE` on the wallet row first, so all writers to one wallet are
 * serialised by Postgres. Callers must lock via `lockWallet*` before calling
 * `postEntry`. Chosen over optimistic retry because contention on a single wallet is
 * low (a member is one human) and a lock keeps the read-check-write sequence honest
 * without any retry loop to get wrong. Lock order across the codebase is always
 * funding_transactions -> wallets, so there is no cycle to deadlock on.
 */

export interface LedgerEntry {
  /** Must already be locked FOR UPDATE by the caller. */
  wallet: Wallet;
  type: WalletTxType;
  /** Signed: positive credits the wallet, negative debits it. */
  amount: BigNumber;
  turnoverRequiredDelta?: BigNumber;
  turnoverAccruedDelta?: BigNumber;
  /**
   * Identifies the real-world effect, not the request. Unique in the database, so
   * posting the same effect twice is impossible even if the application logic slips.
   */
  idempotencyKey: string;
  fundingTransactionId?: string;
}

export async function lockWallet(walletId: string, t: Transaction): Promise<Wallet> {
  const wallet = await Wallet.findOne({
    where: { id: walletId },
    lock: Transaction.LOCK.UPDATE,
    transaction: t,
  });
  if (!wallet) {
    throw new AppError(404, 'wallet_not_found', `no wallet with id ${walletId}`);
  }
  return wallet;
}

export async function lockWalletByMemberId(memberId: string, t: Transaction): Promise<Wallet> {
  const wallet = await Wallet.findOne({
    where: { memberId },
    lock: Transaction.LOCK.UPDATE,
    transaction: t,
  });
  if (!wallet) {
    throw new AppError(404, 'member_not_found', `no wallet for member ${memberId}`);
  }
  return wallet;
}

/**
 * Appends a ledger entry and moves the wallet's cached totals by the same amounts,
 * in one transaction. The ledger is the source of truth: wallets.balance is only ever
 * SUM(wallet_txs.amount), which is what makes the balance reconstructible.
 */
export async function postEntry(entry: LedgerEntry, t: Transaction): Promise<WalletTx> {
  const { wallet } = entry;
  const newBalance = dec(wallet.balance).plus(entry.amount);

  // Callers produce the friendly "insufficient funds" error; this is the invariant
  // that must hold no matter which caller is at fault. The wallets table carries the
  // same CHECK, so a wallet cannot go negative even if this line is bypassed.
  if (newBalance.isNegative()) {
    throw new AppError(409, 'ledger_invariant_violation', 'entry would take the wallet balance negative', {
      walletId: wallet.id,
      balance: money(wallet.balance),
      entryAmount: money(entry.amount),
    });
  }

  const requiredDelta = entry.turnoverRequiredDelta ?? ZERO;
  const accruedDelta = entry.turnoverAccruedDelta ?? ZERO;

  const walletTx = await WalletTx.create(
    {
      walletId: wallet.id,
      fundingTransactionId: entry.fundingTransactionId ?? null,
      type: entry.type,
      amount: money(entry.amount),
      turnoverRequiredDelta: money(requiredDelta),
      turnoverAccruedDelta: money(accruedDelta),
      idempotencyKey: entry.idempotencyKey,
    },
    { transaction: t },
  );

  await wallet.update(
    {
      balance: money(newBalance),
      turnoverRequired: money(dec(wallet.turnoverRequired).plus(requiredDelta)),
      turnoverAccrued: money(dec(wallet.turnoverAccrued).plus(accruedDelta)),
    },
    { transaction: t },
  );

  return walletTx;
}

/** How much more a member must wager before they may withdraw. Never negative. */
export function turnoverOutstanding(wallet: Wallet): BigNumber {
  const outstanding = dec(wallet.turnoverRequired).minus(wallet.turnoverAccrued);
  return outstanding.isNegative() ? ZERO : outstanding;
}
