import { randomUUID } from 'node:crypto';
import BigNumber from 'bignumber.js';
import { sequelize } from '../db/sequelize';
import { FundingTransaction, Wallet } from '../db/models';
import { FundingTransactionStatus, FundingTransactionType } from '../domain/fundingTransactionState';
import { AppError } from '../lib/errors';
import { money } from '../lib/money';

export interface CreateDepositInput {
  memberId: string;
  amount: BigNumber;
  turnoverMultiplier: number;
}

// Opaque and unguessable: the PSP echoes this back as the only thing tying a callback
// to a deposit, so it must not be enumerable by anyone who sees one of them.
function newPspRef(): string {
  return `psp_${randomUUID()}`;
}

/**
 * Registers an intent to fund. No money moves and no ledger entry is written until
 * the PSP confirms (see pspCallbackService).
 */
export async function createDeposit(input: CreateDepositInput): Promise<FundingTransaction> {
  return sequelize.transaction(async (t) => {
    const wallet = await Wallet.findOne({ where: { memberId: input.memberId }, transaction: t });
    if (!wallet) {
      throw new AppError(404, 'member_not_found', `no wallet for member ${input.memberId}`);
    }

    return FundingTransaction.create(
      {
        memberId: input.memberId,
        walletId: wallet.id,
        type: FundingTransactionType.Deposit,
        status: FundingTransactionStatus.Pending,
        amount: money(input.amount),
        turnoverMultiplier: input.turnoverMultiplier,
        pspRef: newPspRef(),
      },
      { transaction: t },
    );
  });
}
