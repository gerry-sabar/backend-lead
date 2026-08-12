import { Transaction } from 'sequelize';
import { sequelize } from '../db/sequelize';
import { FundingTransaction, PspCallback } from '../db/models';
import { CallbackOutcome } from '../db/models/pspCallback';
import { WalletTxType } from '../db/models/walletTx';
import {
  FundingTransactionStatus,
  FundingTransactionType,
  assertTransition,
  isTerminal,
} from '../domain/fundingTransactionState';
import { AppError } from '../lib/errors';
import { dec } from '../lib/money';
import { lockWallet, postEntry } from './ledgerService';

export interface PspCallbackInput {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
  /** The delivery exactly as received, kept for the receipt log. */
  raw: unknown;
}

export interface PspCallbackResult {
  outcome: CallbackOutcome;
  fundingTransactionId: string;
  status: FundingTransactionStatus;
}

/**
 * A delivery that reports an outcome we have already recorded. This is the common
 * case (PSPs retry aggressively and late), so it is a success, not an error: we
 * acknowledge it and move no money.
 *
 * A delivery that reports something *different* from what we recorded is not a
 * replay - it is a contradiction, and it is rejected below rather than applied.
 */
function isReplay(ftx: FundingTransaction, input: PspCallbackInput): boolean {
  if (input.status === 'failed') {
    return ftx.status === FundingTransactionStatus.Failed;
  }
  const recordedAsCompleted =
    ftx.status === FundingTransactionStatus.Completed ||
    ftx.status === FundingTransactionStatus.Disputed;
  return (
    recordedAsCompleted && ftx.settledAmount !== null && dec(input.amount).eq(dec(ftx.settledAmount))
  );
}

async function process(input: PspCallbackInput, t: Transaction): Promise<PspCallbackResult> {
  // Take the funding transaction row lock first. Concurrent deliveries of the same
  // callback contend here: the loser blocks until the winner commits, then re-reads
  // the row and sees a terminal status, so it can only ever take the replay path.
  const ftx = await FundingTransaction.findOne({
    where: { pspRef: input.pspRef },
    lock: Transaction.LOCK.UPDATE,
    transaction: t,
  });

  if (!ftx) {
    throw new AppError(404, 'unknown_psp_ref', `no funding transaction for pspRef ${input.pspRef}`);
  }
  if (ftx.type !== FundingTransactionType.Deposit) {
    throw new AppError(409, 'not_a_deposit', 'callbacks only apply to deposits');
  }

  if (isReplay(ftx, input)) {
    return {
      outcome: CallbackOutcome.DuplicateIgnored,
      fundingTransactionId: ftx.id,
      status: ftx.status,
    };
  }

  if (isTerminal(ftx.status)) {
    // Settled, and this delivery disagrees with how it settled. Never rewrite a
    // terminal state; a late or reordered callback does not get to undo money.
    assertTransition(
      ftx.status,
      input.status === 'completed'
        ? FundingTransactionStatus.Completed
        : FundingTransactionStatus.Failed,
    );
  }

  if (input.status === 'failed') {
    assertTransition(ftx.status, FundingTransactionStatus.Failed);
    await ftx.update(
      { status: FundingTransactionStatus.Failed, statusReason: 'psp_reported_failure' },
      { transaction: t },
    );
    return {
      outcome: CallbackOutcome.Applied,
      fundingTransactionId: ftx.id,
      status: ftx.status,
    };
  }

  // Amount mismatch. The deposit we created is authoritative for how much we credit,
  // and the callback is unauthenticated input, so we credit nothing: park the
  // transaction for a human and record what the PSP claimed. See DECISIONS.md.
  if (!dec(input.amount).eq(dec(ftx.amount))) {
    assertTransition(ftx.status, FundingTransactionStatus.Disputed);
    await ftx.update(
      {
        status: FundingTransactionStatus.Disputed,
        settledAmount: input.amount,
        statusReason: 'amount_mismatch',
      },
      { transaction: t },
    );
    return {
      outcome: CallbackOutcome.AmountMismatch,
      fundingTransactionId: ftx.id,
      status: ftx.status,
    };
  }

  assertTransition(ftx.status, FundingTransactionStatus.Completed);

  const wallet = await lockWallet(ftx.walletId, t);
  await postEntry(
    {
      wallet,
      type: WalletTxType.DepositCredit,
      amount: dec(ftx.amount),
      // The anti-abuse lock: a completed deposit obliges the member to wager
      // amount x multiplier before any of it can be withdrawn.
      turnoverRequiredDelta: dec(ftx.amount).times(ftx.turnoverMultiplier ?? 0),
      idempotencyKey: `deposit:${ftx.id}`,
      fundingTransactionId: ftx.id,
    },
    t,
  );

  await ftx.update(
    { status: FundingTransactionStatus.Completed, settledAmount: input.amount },
    { transaction: t },
  );

  return { outcome: CallbackOutcome.Applied, fundingTransactionId: ftx.id, status: ftx.status };
}

function outcomeForError(err: unknown): CallbackOutcome {
  if (err instanceof AppError) {
    if (err.code === 'unknown_psp_ref') return CallbackOutcome.UnknownRef;
    if (err.code === 'invalid_state_transition') return CallbackOutcome.InvalidTransition;
  }
  return CallbackOutcome.Rejected;
}

/**
 * Entry point for the webhook. The receipt is written outside the processing
 * transaction and updated afterwards, so deliveries we reject - unknown refs,
 * contradictions, mismatched amounts - survive the rollback and stay visible.
 */
export async function handlePspCallback(input: PspCallbackInput): Promise<PspCallbackResult> {
  const receipt = await PspCallback.create({ pspRef: input.pspRef, payload: input.raw });

  try {
    const result = await sequelize.transaction((t) => process(input, t));
    await receipt.update({
      outcome: result.outcome,
      fundingTransactionId: result.fundingTransactionId,
    });
    return result;
  } catch (err) {
    // Annotating the receipt must never mask why we actually rejected the delivery:
    // the original error is the one worth surfacing and logging.
    await receipt.update({ outcome: outcomeForError(err) }).catch(() => undefined);
    throw err;
  }
}
