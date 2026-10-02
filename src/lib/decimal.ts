/**
 * Minimal exact decimal arithmetic for aggregation.
 * value = int / 10^scale. Sums never lose source precision (unlike IEEE floats),
 * so totals match the source to the cent; rounding happens only at display time.
 */
export interface Decimal {
  readonly int: bigint;
  readonly scale: number;
}

export const ZERO: Decimal = { int: 0n, scale: 0 };

const PLAIN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Parse a plain decimal string such as "-1234.5600". Returns null if not numeric. */
export function decimalFromPlain(text: string): Decimal | null {
  const m = PLAIN.exec(text.trim());
  if (!m) return null;
  const [, sign, whole = '', frac = ''] = m;
  if (whole === '' && frac === '') return null;
  const digits = (whole + frac).replace(/^0+(?=\d)/, '') || '0';
  const int = BigInt(digits) * (sign === '-' ? -1n : 1n);
  return { int, scale: frac.length };
}

/** Convert a JS number using its shortest round-trip representation (what Excel stored). */
export function decimalFromNumber(n: number): Decimal | null {
  if (!Number.isFinite(n)) return null;
  let s = String(n);
  if (/e/i.test(s)) {
    s = n.toFixed(20).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return decimalFromPlain(s);
}

function rescale(d: Decimal, scale: number): bigint {
  return d.int * 10n ** BigInt(scale - d.scale);
}

export function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { int: rescale(a, scale) + rescale(b, scale), scale };
}

export function sum(values: Iterable<Decimal>): Decimal {
  let acc = ZERO;
  for (const v of values) acc = add(acc, v);
  return acc;
}

export function equals(a: Decimal, b: Decimal): boolean {
  const scale = Math.max(a.scale, b.scale);
  return rescale(a, scale) === rescale(b, scale);
}

/** Exact plain-string representation with trailing fractional zeros trimmed. */
export function toPlainString(d: Decimal): string {
  const neg = d.int < 0n;
  const abs = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, '0');
  const whole = abs.slice(0, abs.length - d.scale);
  const frac = d.scale ? abs.slice(abs.length - d.scale).replace(/0+$/, '') : '';
  const body = frac ? `${whole}.${frac}` : whole;
  return neg && body !== '0' ? `-${body}` : body;
}

export function toNumber(d: Decimal): number {
  return Number(toPlainString(d));
}
