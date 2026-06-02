// apps/backend/src/utils/numberToWords.ts
// Converts a rupee amount into Indian-format words
// (e.g. "Indian Rupee One Lakh Twenty-Three Thousand ... Only").
// Extracted verbatim from invoicePdf.ts so the invoice and credit-note PDF
// renderers share one implementation. Pure function — no side effects.
export function numberToWords(amount: number): string {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
    "Seventeen", "Eighteen", "Nineteen",
  ];
  const tensW = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  function twoDigit(n: number): string {
    if (n === 0) return "";
    if (n < 20) return ones[n];
    const t = tensW[Math.floor(n / 10)];
    const o = ones[n % 10];
    return o ? `${t}-${o}` : t;
  }

  function threeDigit(n: number): string {
    if (n === 0) return "";
    const h = Math.floor(n / 100);
    const r = n % 100;
    let s = h > 0 ? `${ones[h]} Hundred` : "";
    if (r > 0) s += (s ? " " : "") + twoDigit(r);
    return s;
  }

  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  if (rupees === 0 && paise === 0) return "Indian Rupee Zero Only";

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thou = Math.floor((rupees % 100_000) / 1_000);
  const rem = rupees % 1_000;

  if (crore > 0) parts.push(`${threeDigit(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigit(lakh)} Lakh`);
  if (thou > 0) parts.push(`${twoDigit(thou)} Thousand`);
  if (rem > 0) parts.push(threeDigit(rem));

  let result = parts.join(" ");
  result += paise > 0 ? ` and ${twoDigit(paise)} Paise Only` : " Only";
  return `Indian Rupee ${result}`;
}
