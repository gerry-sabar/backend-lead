import { z } from 'zod';
import { dec } from '../lib/money';

// Money crosses the boundary as a string decimal and is parsed straight into a
// BigNumber. Numbers are rejected outright: a JSON number has already lost precision
// by the time we see it.
//
// The digit bounds are the capacity of DECIMAL(36,18) exactly, so an oversized amount
// is a 400 at the edge rather than a numeric overflow and a 500 at the database.
const DECIMAL_STRING = /^\d{1,18}(\.\d{1,18})?$/;

export const positiveMoney = z
  .string()
  .regex(DECIMAL_STRING, 'must be a decimal string with at most 18 integer and 18 decimal places')
  .transform(dec)
  .refine((value) => value.isGreaterThan(0), 'must be greater than zero');
