// rates are 8dp decimal strings, math stays integer, one half-even rounding here
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
  if (!Number.isSafeInteger(asNumber)) throw new Error('convertCents overflow');
  return asNumber;
}
