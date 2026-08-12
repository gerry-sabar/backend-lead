# CLAUDE.md

Mini wallet service: a regulated, real-money transactional platform. Correctness of
money movement is the property that matters; a bug here is an incident, not a ticket.

The service is in `starter/` — run every command from there. `DECISIONS.md` and
`DESIGN-PSP.md` are deliverable docs and live here in `backend-lead/`.

## Commands

```bash
npm run db:up        # Postgres in Docker on :5439
npm run db:migrate   # dev database
npm test             # migrates wallet_test, then jest --runInBand
npm run dev          # API on :3000
./scripts/walkthrough.sh   # drives the whole flow with curl against a running dev server
```

`npm test` uses the `wallet_test` database and truncates between tests. `npm run dev`
uses `wallet`. Test data is gone before you can query it; dev data accumulates.

## Read `DECISIONS.md` before changing money behaviour

This file holds the rules; `DECISIONS.md` holds the reasoning behind them and the
alternatives already rejected. It is not loaded automatically — read it before touching
settlement, the state machine, turnover, or anything that decides how much a wallet
moves by. Re-litigating a decision recorded there without reading it wastes the work.

## Money invariants

These are not style preferences. Breaking one is how a wallet loses money.

1. **Money never touches a JS `number`.** Strings at the boundary, `BigNumber` in
   between, `DECIMAL(36,18)` at rest. The zod schemas reject JSON numbers on purpose —
   by the time we see one it has already lost precision. Use `dec()` and `money()` from
   `src/lib/money.ts`.
2. **Every balance change goes through `postEntry()`** in `src/services/ledgerService.ts`.
   Nothing else writes `wallets.balance`. If you find yourself updating a balance
   directly, the design is wrong, not the rule.
3. **Hold the wallet row lock first.** Callers take `lockWallet()` or
   `lockWalletByMemberId()` before `postEntry()`. A read-check-write on a balance
   without the lock is a race, however unlikely it looks.
4. **Lock order is always `funding_transactions` → `wallets`.** Never the reverse, never
   two wallets in one transaction. This is the only reason there is no deadlock cycle.
5. **`wallet_txs` is append-only.** Corrections are reversing entries, never `UPDATE` or
   `DELETE`. A trigger enforces this, so an attempt fails loudly rather than silently
   rewriting history.
6. **`wallets.balance`, `turnover_required` and `turnover_accrued` are caches** of sums
   over `wallet_txs`. Any new money-shaped column on the wallet needs a matching
   `*_delta` on the ledger, or reconstructibility is lost.
7. **Every ledger entry carries an `idempotency_key` naming the effect**, not the
   request — `deposit:<ftxId>`, not a request id. It is `UNIQUE` in the database
   deliberately: it is the assertion that the application logic worked.
8. **Status changes go through `assertTransition()`** in
   `src/domain/fundingTransactionState.ts`. `pending` is the only non-terminal state;
   `completed`, `failed` and `disputed` are terminal. A late or reordered callback must
   never rewrite a settled transaction.

## Schema

- New tables and columns via migrations. Never `sync()`.
- Put invariants in the database, not only in TypeScript: `CHECK`, `UNIQUE`, triggers.
  Application code is one bug away from being bypassed; a constraint is not.
- Verify a migration rolls back before moving on:
  `npx sequelize-cli db:migrate:undo:all && npm run db:migrate`.

## Code conventions

- Routes validate with zod and delegate. No business logic in routes.
- Services own transactions. Any operation writing more than one row runs in one.
- `AppError(status, code, message, details)` for anything the caller should see.
  Everything else becomes a 500 with no detail.
- No heavy dependencies (queues, ORMs, frameworks). The exercise fits what is here.

## Testing

- **A concurrency test must fail when the safety is removed.** Verify a new one by
  deleting the relevant `lock: Transaction.LOCK.UPDATE` and re-running — if it still
  passes, the test is theatre. Restore the lock afterwards.
- Assert against the ledger, not only the API response: re-sum `wallet_txs` in SQL and
  compare to `wallets.balance`.
- Concurrency is exercised with `Promise.all` of real HTTP requests, not mocks.

## Ask, do not assume

Money semantics are business decisions, and picking one silently is the failure mode
that matters here. If a change turns on any of these, state the assumption and ask:

- What to do when two sources disagree about an amount.
- Whether a state transition should be allowed, or a new state is needed.
- Whether a failure should reverse money, block it, or park it for a human.
- Rounding, anywhere.
- Whether turnover requirements reset, expire, or are scoped per deposit.

Whatever is decided goes in `DECISIONS.md` with the reasoning, including the
alternatives rejected. That file is read more closely than the code.
