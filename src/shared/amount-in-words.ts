// Paise -> Indian-numbering (lakh/crore) words, for the printable invoice payload (TDD §28.6).
// Pure/computed at print time, never stored — mirrors the amount-in-words line on a TallyPrime
// invoice ("Rupees ... and Paise ... Only").

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(n: number): string {
  if (n < 20) return ONES[n]!;
  const tens = TENS[Math.floor(n / 10)]!;
  const ones = n % 10;
  return ones ? `${tens} ${ONES[ones]}` : tens;
}

function threeDigitWords(n: number): string {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(twoDigitWords(rest));
  return parts.join(" ");
}

// Indian grouping: ...crore,lakh,thousand,hundred — 2-digit groups above the last 3 digits.
export function numberToIndianWords(n: number): string {
  if (n === 0) return "Zero";

  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const hundreds = n % 1e3;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigitWords(thousand)} Thousand`);
  if (hundreds) parts.push(threeDigitWords(hundreds));

  return parts.join(" ");
}

// Never stored (TDD §28.6) — computed fresh from the paise total every time the payload is
// assembled. Caller guarantees a nonnegative amount (grand_total is never signed).
export function amountInWords(paise: bigint): string {
  const rupees = Number(paise / 100n);
  const paiseRemainder = Number(paise % 100n);

  let result = `Rupees ${numberToIndianWords(rupees)}`;
  if (paiseRemainder > 0) {
    result += ` and ${numberToIndianWords(paiseRemainder)} Paise`;
  }
  return `${result} Only`;
}
