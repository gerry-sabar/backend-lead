import { randomUUID } from 'node:crypto';
import BigNumber from 'bignumber.js';
import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import { WalletTxType } from '../db/models/walletTx';
import { AppError } from '../lib/errors';
import { dec, money } from '../lib/money';
import { lockWallet, postEntry } from './ledgerService';

/**
 * Debits the wallet and accrues turnover against the withdrawal lock.
 *
 * The balance check and the debit happen under the wallet row lock, so two concurrent
 * wagers are serialised: the second one reads the balance the first one left behind
 * and is rejected if that is no longer enough.
 */
export async function recordWager(
  walletId: string,
  amount: BigNumber,
): Promise<{ walletTx: WalletTx; wallet: Wallet }> {
  return sequelize.transaction(async (t) => {
    const wallet = await lockWallet(walletId, t);

    if (dec(wallet.balance).lt(amount)) {
      throw new AppError(422, 'insufficient_funds', 'wallet balance is too low for this wager', {
        balance: money(wallet.balance),
        requested: money(amount),
      });
    }

    const walletTx = await postEntry(
      {
        wallet,
        type: WalletTxType.WagerDebit,
        amount: amount.negated(),
        turnoverAccruedDelta: amount,
        // Wagers have no natural idempotency key: two identical wagers seconds apart
        // are two real wagers. A client-supplied Idempotency-Key would slot in here;
        // see DECISIONS.md.
        idempotencyKey: `wager:${randomUUID()}`,
      },
      t,
    );

    return { walletTx, wallet };
  });
}
