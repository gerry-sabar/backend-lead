# Mini Wallet Service - Starter

This is the starter codebase for the Backend Lead take-home. The task itself is described in [`../readme.md`](../readme.md).

## Stack

TypeScript, Express, Sequelize, PostgreSQL, Jest. Money is `DECIMAL(36,18)` in Postgres, strings in JS/JSON, and all arithmetic goes through `bignumber.js` (see `src/lib/money.ts`).

## Setup

Requires Node 20+ and Docker.

```bash
cp .env.example .env
npm install
npm run db:up        # starts Postgres on localhost:5439 (dev + test databases)
npm run db:migrate   # migrates the dev database
npm test             # migrates the test database and runs the test suite
npm run dev          # starts the API on :3000
```

If port 5439 clashes with something on your machine, change it in `docker-compose.yml` and `.env`.

## Layout

```
src/
├── app.ts               # express app factory
├── index.ts             # entrypoint
├── config.ts
├── lib/money.ts         # BigNumber helpers - use these for all money math
├── db/
│   ├── sequelize.ts
│   ├── cli-config.js    # sequelize-cli config (used by npm run db:migrate)
│   ├── migrations/      # add your migrations here
│   └── models/
├── routes/
└── services/
test/                    # add your tests here
```

## API

| Endpoint | Does |
| --- | --- |
| `POST /members` | Creates a member and a zero-balance wallet |
| `GET /members/:memberId/wallet` | Balance and turnover totals |
| `POST /deposits` | Files a `pending` deposit, returns its `pspRef`. No money moves |
| `POST /psp/callbacks` | Settles a deposit. Idempotent, safe under concurrent delivery |
| `POST /wallets/:walletId/wagers` | Debits the wallet, accrues turnover |
| `POST /withdrawals` | Debits the wallet and files a `pending` withdrawal, if turnover allows |

Money is a string decimal in every request and response. The reasoning behind the
money-movement design is in [`../DECISIONS.md`](../DECISIONS.md).

`npm run dev`, then `./scripts/walkthrough.sh` drives the whole flow with curl:
deposit, settlement, duplicate and concurrent callbacks, wagers, the turnover lock, and
the hostile cases (unknown ref, amount mismatch, illegal transition).

### Data model

- `funding_transactions` — the lifecycle of money entering (deposit) or leaving
  (withdrawal) the platform: `pending → completed / failed / disputed`.
- `wallet_txs` — the append-only ledger. One row per balance change, signed amounts.
  `wallets.balance` is a cache of `SUM(amount)`; the same holds for the turnover totals.
- `psp_callbacks` — a receipt for every inbound delivery, including rejected ones.

## Conventions to keep

- Money never touches JS `number`. Strings at the boundaries, BigNumber in between.
- Any operation writing more than one row runs in a single DB transaction (see `memberService.createMember`).
- Routes validate input with zod and delegate to services; business logic lives in services, not routes.
- New tables are created via migrations, not `sync()`.
