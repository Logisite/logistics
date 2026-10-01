// rates are 8dp decimal strings, math stays integer, one half-even rounding here
import { and, eq, lte, sql } from 'drizzle-orm';

import { fxRates } from '@logistics/db';

import { getConfig } from '../../shared/config.js';
import { badRequest } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

import type { Db } from '../../shared/db.js';

export type Currency = 'USD' | 'EUR' | 'GBP';

// one functional currency per deployment, ADR 0004
export const FUNCTIONAL_CURRENCY: Currency = getConfig().functionalCurrency;

const RATE_SCALE_DIGITS = 8;
const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DIGITS);

function parseRateToScaledBigInt(rate: string): bigint {
  const neg = rate.startsWith('-');
  const [int = '0', frac = ''] = (neg ? rate.slice(1) : rate).split('.');
  const fracPadded = frac.padEnd(RATE_SCALE_DIGITS, '0').slice(0, RATE_SCALE_DIGITS);
  const scaled = BigInt(int + fracPadded);
  return neg ? -scaled : scaled;
}

function divRoundHalfEven(num: bigint, den: bigint): bigint {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const twiceRemainder = (a % b) * 2n;
  let result = q;
  if (twiceRemainder > b || (twiceRemainder === b && q % 2n === 1n)) result += 1n;
  return negative ? -result : result;
}

export function convertCents(amountCents: number, rate: string): number {
  const converted = divRoundHalfEven(BigInt(amountCents) * parseRateToScaledBigInt(rate), RATE_SCALE);
  const asNumber = Number(converted);
  if (!Number.isSafeInteger(asNumber)) {
    logger.error({ amountCents, rate }, 'cod.fx-conversion-overflow');
    throw new Error('convertCents overflow');
  }
  return asNumber;
}

type Queryable = Pick<Db, 'select'>;

/** The most recent rate dated on or before `at`. */
export async function latestRate(
  q: Queryable,
  from: Currency,
  to: Currency,
  at: Date,
): Promise<{ rate: string; rateDate: Date }> {
  const [row] = await q
    .select({ rate: fxRates.rate, rateDate: fxRates.rateDate })
    .from(fxRates)
    .where(and(eq(fxRates.fromCurrency, from), eq(fxRates.toCurrency, to), lte(fxRates.rateDate, at)))
    .orderBy(sql`${fxRates.rateDate} desc`)
    .limit(1);
  if (!row) throw badRequest('FX_RATE_MISSING', `No ${from}->${to} rate on or before ${at.toISOString()}`);
  return row;
}

export function toFunctional(amountCents: number, currency: Currency, rate: string): number {
  return currency === FUNCTIONAL_CURRENCY ? amountCents : convertCents(amountCents, rate);
}
