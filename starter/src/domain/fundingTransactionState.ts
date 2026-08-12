import { AppError } from '../lib/errors';

export const FundingTransactionType = {
  Deposit: 'deposit',
  Withdrawal: 'withdrawal',
} as const;

export type FundingTransactionType =
  (typeof FundingTransactionType)[keyof typeof FundingTransactionType];

export const FundingTransactionStatus = {
  Pending: 'pending',
  Completed: 'completed',
  Failed: 'failed',
  // Not in the brief. A completed callback whose amount disagrees with the deposit
  // is neither a success nor a failure: it is money we refuse to move automatically.
  // Resolving it is a human/back-office job, deliberately out of scope here.
  Disputed: 'disputed',
} as const;

export type FundingTransactionStatus =
  (typeof FundingTransactionStatus)[keyof typeof FundingTransactionStatus];

// Everything reachable from Pending is terminal for the automated path. There is no
// "un-complete", no "re-open": a late or reordered callback cannot rewrite history.
const ALLOWED_TRANSITIONS: Record<FundingTransactionStatus, readonly FundingTransactionStatus[]> = {
  [FundingTransactionStatus.Pending]: [
    FundingTransactionStatus.Completed,
    FundingTransactionStatus.Failed,
    FundingTransactionStatus.Disputed,
  ],
  [FundingTransactionStatus.Completed]: [],
  [FundingTransactionStatus.Failed]: [],
  [FundingTransactionStatus.Disputed]: [],
};

export function canTransition(
  from: FundingTransactionStatus,
  to: FundingTransactionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: FundingTransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/**
 * Guards every status write. An illegal transition is a bug or a hostile/misordered
 * delivery, so it throws rather than silently no-ops.
 */
export function assertTransition(
  from: FundingTransactionStatus,
  to: FundingTransactionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'invalid_state_transition', `cannot move funding transaction from ${from} to ${to}`, {
      from,
      to,
    });
  }
}
