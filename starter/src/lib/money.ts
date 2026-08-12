import BigNumber from 'bignumber.js';

// Money invariants for this codebase:
// - Money is stored as DECIMAL(36,18) in Postgres and travels as strings in JS/JSON.
// - All arithmetic on money MUST go through BigNumber. Never use JS number math on money.
BigNumber.config({ DECIMAL_PLACES: 18, ROUNDING_MODE: BigNumber.ROUND_DOWN });

const SCALE = 18;

export function dec(value: string | number | BigNumber): BigNumber {
  const bn = new BigNumber(value);
  if (!bn.isFinite()) {
    throw new Error(`Invalid money value: ${value}`);
  }
  return bn;
}

export const ZERO = dec(0);

/**
 * Renders money for the database and for JSON responses at the column's own scale,
 * so a value read back from Postgres compares equal to the one we sent.
 * `toFixed` (not `toString`) because exponential notation is not valid DECIMAL input.
 */
export function money(value: string | number | BigNumber): string {
  return dec(value).toFixed(SCALE);
}
