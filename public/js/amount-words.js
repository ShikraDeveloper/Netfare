// Amounts in words for printed documents. Kept free of browser imports so
// tests can load it directly.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function wordsBelowThousand(n) {
  const parts = [];
  if (n >= 100) parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
  const rest = n % 100;
  if (rest >= 20) parts.push(TENS[Math.floor(rest / 10)] + (rest % 10 ? `-${ONES[rest % 10]}` : ''));
  else if (rest) parts.push(ONES[rest]);
  return parts.join(' ');
}

function numberWords(n) {
  if (n === 0) return 'Zero';
  const scales = [[1_000_000_000, 'Billion'], [1_000_000, 'Million'], [1_000, 'Thousand']];
  const parts = [];
  let rest = n;
  for (const [size, name] of scales) {
    if (rest >= size) {
      parts.push(`${wordsBelowThousand(Math.floor(rest / size))} ${name}`);
      rest %= size;
    }
  }
  if (rest) parts.push(wordsBelowThousand(rest));
  return parts.join(' ');
}

// "UAE Dirhams Seven Hundred Thirty and Fifty Fils Only", as printed on invoices.
export function amountInWords(cents) {
  const value = Math.abs(Math.round(Number(cents) || 0));
  const dirhams = Math.floor(value / 100);
  const fils = value % 100;
  return `UAE Dirhams ${numberWords(dirhams)}${fils ? ` and ${numberWords(fils)} Fils` : ''} Only`;
}
