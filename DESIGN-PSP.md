# The 50th PSP

**The boundary: an adapter turns bytes into a normalized event, and never touches money.**
Signatures, minor units, status vocabulary and ordering quirks all live outside that
line. The settlement core stays as it is today and never learns a provider's name.

```
POST /psp/:provider/callbacks
        |
        v
  [ registry ]  provider id -> adapter + config + secrets
        |
        v
  adapter.verify(rawBody, headers, secrets)   <- signature over RAW BYTES, throws
        |
        v
  adapter.parse(rawBody, headers)  -> NormalizedEvent   <- PURE. no DB, no clock, no net
        |
        v
==================== provider-agnostic from here down ====================
  handlePspCallback(event)   <- unchanged: row lock, state machine, ledger, receipt
        |
        v
  funding_transactions + wallet_txs
```

## The interface

```ts
interface PspAdapter {
  readonly id: string;                                  // 'adyen', 'stripe'
  verify(raw: RawDelivery, secrets: PspSecrets): void;  // throws; the only I/O-ish step
  parse(raw: RawDelivery): NormalizedEvent;             // pure function
}

interface NormalizedEvent {
  pspRef: string;                              // our reference, echoed back
  status: 'completed' | 'failed' | 'ignored';  // provider vocabulary mapped here
  amount: string;                              // major units, decimal string
  currency: string;
  providerEventId: string;                     // for the receipt log and ordering
  occurredAt: Date;                            // provider's clock, recorded not trusted
}
```

Two rules make this work. **`parse` is pure** — raw bytes in, plain object out — so it is
testable without a database, a network, or a running app. And **`verify` runs on the raw
body**, before JSON parsing, because signatures are computed over bytes; re-serializing
first is the classic way to break them (so this route uses `express.raw`, not
`express.json`).

Statuses meaning "not final yet" map to `ignored` and are dropped. That handles *"some
send `success` before `pending`"* on its own: a late `pending` cannot reopen a settled
transaction, because the core's terminal states already refuse it.

## Config, not code

Per provider, a declarative record: status map, minor-unit exponent, signature algorithm
and header, clock-skew tolerance, enabled-per-environment. Secrets come from the
environment and are injected, never read inside an adapter. Nothing in the core branches
on provider id — the registry is the only lookup, so a new provider is a new entry, not
a new `if`.

## Testing a provider you can't call in CI

Never call the real thing in CI. Three layers instead:

1. **Golden fixtures.** Real payloads captured from the provider's docs, sandbox, or our
   own webhook logs, committed as files. The test asserts `parse(fixture)` equals an
   expected `NormalizedEvent`. This is the bulk of an integration's tests and it is
   entirely offline.
2. **A shared conformance suite** — one parameterized test file that *every* adapter must
   pass: rejects a tampered signature, rejects a stale timestamp, converts minor units
   without float error, maps every documented status, refuses an unknown status rather
   than guessing. Adding a provider means supplying fixtures and going green on a suite
   you did not write. This is what makes the work a day rather than a fortnight.
3. **A sandbox smoke test outside CI** — nightly, allowed to fail, alerting the
   integrations channel. It catches the provider changing their payload, which no
   fixture can predict: a fixture is by definition yesterday's truth.

## Adding a provider: the checklist

1. `src/psp/adapters/<name>/index.ts` — `verify` and `parse`.
2. `src/psp/adapters/<name>/fixtures/*.json` — captured payloads.
3. One entry in the registry; secrets in env.
4. Run the conformance suite until green.

Four files, none of them money code.

## Why a junior can do this safely

Blast radius. A wrong adapter can produce a wrong `NormalizedEvent` — but it *cannot*
double-credit a wallet, overdraw one, or reopen a settled transaction, because the row
locks, the state machine and the unique `idempotency_key` on the ledger all sit behind
the boundary and apply identically to every provider. The worst realistic bug is a
deposit that ends up `disputed` and waits for a human, which is the outcome we already
designed for. The scary code was written once; adapters are the safe part.

**One thing the core still needs:** `currency`. Today's schema is implicitly
single-currency; a multi-PSP platform is not. A currency column on wallets and the
ledger, one wallet per member per currency — a change to make before the second
provider, not after the tenth.
