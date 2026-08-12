import BigNumber from 'bignumber.js';
import { sequelize } from '../db/sequelize';
import { FundingTransaction, Wallet } from '../db/models';
import { WalletTxType } from '../db/models/walletTx';
import { FundingTransactionStatus, FundingTransactionType } from '../domain/fundingTransactionState';
import { AppError } from '../lib/errors';
import { dec, money } from '../lib/money';
import { lockWalletByMemberId, postEntry, turnoverOutstanding } from './ledgerService';

/**
 * Debits the wallet immediately and files a Pending withdrawal for a human to approve.
 *
 * The turnover check, the balance check and the debit all happen under the wallet row
 * lock, so a wager cannot slip in between the check and the debit in either direction.
 */
export async function createWithdrawal(
  memberId: string,
  amount: BigNumber,
): Promise<{ fundingTransaction: FundingTransaction; wallet: Wallet }> {
  return sequelize.transaction(async (t) => {
    const wallet = await lockWalletByMemberId(memberId, t);

    const outstanding = turnoverOutstanding(wallet);
    if (outstanding.isGreaterThan(0)) {
      throw new AppError(
        422,
        'turnover_requirement_not_met',
        'member has outstanding turnover and cannot withdraw yet',
        {
          turnoverRequired: money(wallet.turnoverRequired),
          turnoverAccrued: money(wallet.turnoverAccrued),
          turnoverOutstanding: money(outstanding),
        },
      );
    }

    if (dec(wallet.balance).lt(amount)) {
      throw new AppError(422, 'insufficient_funds', 'wallet balance is too low for this withdrawal', {
        balance: money(wallet.balance),
        requested: money(amount),
      });
    }

    const fundingTransaction = await FundingTransaction.create(
      {
        memberId,
        walletId: wallet.id,
        type: FundingTransactionType.Withdrawal,
        status: FundingTransactionStatus.Pending,
        amount: money(amount),
      },
      { transaction: t },
    );

    await postEntry(
      {
        wallet,
        type: WalletTxType.WithdrawalDebit,
        amount: amount.negated(),
        idempotencyKey: `withdrawal:${fundingTransaction.id}`,
        fundingTransactionId: fundingTransaction.id,
      },
      t,
    );

    return { fundingTransaction, wallet };
  });
}
