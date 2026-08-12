# Decisions

Part A is implemented in `starter/`. `npm test` runs 44 tests against a real Postgres;
all pass.

## The shape of the solution

Three new tables, one new idea:

- **`funding_transactions`** owns the *lifecycle* of money entering or leaving the
  platform (a deposit or a withdrawal) and its state machine.
- **`wallet_txs`** owns the *movement* of money. Append-only, signed amounts, one row
  per balance change. `wallets.balance` is a cache of `SUM(amount)` and nothing more.
- **`psp_callbacks`** is a receipt log of every inbound delivery, including the ones we
  refuse.

The idea: **a funding transaction can settle many times, but it can only post to the
ledger once.** Everything else follows from separating those two things.

## Concurrency: pessimistic row locks, in a fixed order

Every path that changes a balance takes `SELECT ... FOR UPDATE` before it reads the
number it is about to act on:

| Path | Locks |
| --- | --- |
| PSP callback | `funding_transactions` row, then the `wallets` row |
| Wager | `wallets` row |
| Withdrawal | `wallets` row |

Two concurrent deliveries of the same callback contend on the funding transaction row.
The loser blocks until the winner commits, then — under Postgres READ COMMITTED, which
re-reads a locked row after the blocking transaction commits — sees `completed` and
takes the replay path. It never re-evaluates a stale `pending`.

Concurrent wagers contend on the wallet row, so the balance check and the debit cannot
be separated by another writer.

**Why locks and not optimistic retry / `UPDATE ... WHERE balance >= ?`:** contention on
a single wallet is inherently low (a wallet belongs to one human), so the cost of a lock
is near zero, and it keeps read-check-write sequences legible with no retry loop to get
subtly wrong. A conditional `UPDATE` would handle the wager case neatly but not the
callback case, where the decision depends on state across two tables. One mechanism
everywhere beats two.

Lock order is always `funding_transactions → wallets`, so there is no cycle to deadlock
on. Nothing locks two wallets.

## Idempotency, in three layers

1. **State machine.** `pending` is the only non-terminal state. `completed`, `failed`
   and `disputed` are terminal: nothing transitions out of them, so a late or reordered
   callback cannot rewrite history. `assertTransition` throws rather than no-ops.
2. **Replay detection.** A delivery reporting an outcome we already recorded (same
   status, and for a completed one the same amount) is acknowledged with
   `duplicate_ignored`. A delivery reporting something *different* is not a replay, it
   is a contradiction — `409`.
3. **A unique key on the effect.** `wallet_txs.idempotency_key` is
   `deposit:<ftxId>` / `withdrawal:<ftxId>`, unique in the database. If the application
   logic above ever slipped, the second credit would violate a constraint and roll the
   transaction back rather than double-credit. Layers 1–2 are the mechanism; layer 3 is
   the assertion that they worked.

Belt and braces beyond that: `wallets.balance >= 0` as a CHECK constraint, and a trigger
that rejects `UPDATE`/`DELETE` on `wallet_txs`. Append-only should be a property the
database holds, not a comment the next engineer has to read.

## Judgement calls

**Callback amount ≠ deposit amount → credit nothing.** The deposit we created is
authoritative. The callback is unauthenticated input in this exercise, so treating its
amount as authoritative would mean anyone who can reach the endpoint can mint money. The
transaction moves to `disputed`, the claimed amount is recorded in `settled_amount`, and
a human resolves it. Alternatives the system rejected: crediting `min(expected, actual)` silently
loses the player's money on an overpayment and hides a broken integration; crediting the
PSP's figure is the mint-money hole above. If the callback were signature-verified I
would revisit this and auto-credit the settled amount for the underpay case, because
partial capture is a real PSP behaviour — but the resolution path still has to exist.

**Response is `200`, not an error.** We have durably decided; the PSP has nothing useful
left to retry, and a 4xx just makes aggressive retriers retry harder.

**Unknown `pspRef` → `404`, and we log it.** A reference we have never issued will never
become valid, so retries are pointless — but the delivery is written to `psp_callbacks`
with outcome `unknown_ref` before we reject it, so a misconfigured integration pointing
at the wrong environment shows up on both sides rather than vanishing. The receipt is
written *outside* the processing transaction precisely so it survives the rollback.

**`disputed` is a fourth state, beyond the brief's `Pending → Completed / Failed`.** A
mismatched amount is neither a success nor a failure and collapsing it into either loses
information at exactly the moment you need it. It is terminal for the automated path;
back-office resolution is out of scope.

**Turnover lives on the wallet, as running totals.** `turnover_required` and
`turnover_accrued`, moved under the same row lock as the balance and derived from the
same ledger rows (`turnover_required_delta`, `turnover_accrued_delta`), so all three
numbers reconstruct from `wallet_txs`. Required accrues on deposit *settlement*, not on
deposit creation — an unpaid deposit must not lock a wallet. The totals are lifetime and
never reset; real platforms scope turnover per bonus or per deposit cycle, which is a
schema change (a `turnover_obligations` table), not a logic change.

**Money never becomes a JS number.** Strings at the boundary, `BigNumber` in between,
`DECIMAL(36,18)` at rest. The zod schema rejects JSON numbers outright: by the time we
see one it has already lost precision.

## Deviations from the starter conventions

- Added `src/domain/` for the state machine and `src/lib/errors.ts` for `AppError`.
  Routes stayed thin, all business logic is in services.
- Added `money()` to `src/lib/money.ts`, which renders at the column's scale so a value
  read back from Postgres compares equal to the one written.
- Extended `GET /members/:memberId/wallet` with the turnover fields.
- No new dependencies.

## Tests

44 tests. Beyond the four required cases (sequential duplicate, concurrent duplicate,
concurrent wagers, turnover lock blocking and unblocking):

- Five concurrent duplicate callbacks: exactly one `applied`, four `duplicate_ignored`.
- Ten concurrent wagers of 15 against a balance of 100: exactly six succeed, four are
  rejected, balance lands on exactly 10.
- A withdrawal racing the wager that clears the last of the turnover — it has no winning
  interleaving, and the failure reason tells you which order it landed in.
- Every ledger assertion re-sums `wallet_txs` in SQL and compares to `wallets.balance`.
- The append-only trigger actually rejects `UPDATE` and `DELETE`.

**I verified the concurrency tests have teeth by removing the row locks and re-running
them.** Without locks all ten wagers succeed (the wallet loses 50) and concurrent
callbacks double-credit. A concurrency test that passes with the safety removed is
theatre; these fail.

## What I would do next

1. **Reconciliation job.** The ledger is authoritative but nothing currently proves the
   cached balance still matches it. A periodic `SUM(wallet_txs) = wallets.balance` sweep
   across all wallets, alerting on any drift, is the control that turns "should be
   consistent" into "is consistent".
2. **Client-supplied `Idempotency-Key` on wagers.** Wagers have no natural idempotency
   key — two identical wagers seconds apart are two real wagers — so a double-submitted
   request is currently two debits. The ledger's unique key is already the right hook.
3. **Callback authentication.** Signature verification per PSP, which also unblocks
   revisiting the amount-mismatch decision above.
4. **Withdrawal approval and reversal.** Approve/reject transitions, with a reversing
   ledger entry on rejection rather than a delete — the same append-only discipline.
5. **Money-shaped observability.** Counters on `duplicate_ignored`, `amount_mismatch`,
   `unknown_ref` and `invalid_state_transition`. Each of those is a broken integration
   or an attack, and today they are only visible by querying `psp_callbacks`.
6. **Load-test the lock.** The row lock is the right call at a wallet's natural
   contention, but "high transaction volume" deserves a number rather than my assertion.

## AI disclosure

I used Claude Code (Opus) throughout this exercise: the schema and migrations, the
service and route implementation, the test suite, and the first drafts of this document
and `DESIGN-PSP.md`.

The design decisions are mine and I own them. The ones that carry the reasoning:

- **Pessimistic row locks** over optimistic retry or a conditional
  `UPDATE ... WHERE balance >= ?`, with a fixed `funding_transactions → wallets` lock
  order so there is no deadlock cycle.
- **Separating lifecycle from movement** — `funding_transactions` owns state,
  `wallet_txs` owns money. That split is what makes "a transaction can settle many
  times, but credit once" expressible at all.
- **Refusing to credit a mismatched callback amount**, and adding `disputed` rather than
  forcing a mismatch into `completed` or `failed` and losing the information.
- **Pushing invariants into the database** — CHECK constraints, the unique
  `idempotency_key`, the append-only trigger — rather than trusting application code not
  to be bypassed.
- **Verifying the concurrency tests by removing the row locks** and confirming they fail.
  A concurrency test that passes with the safety removed is testing nothing.
