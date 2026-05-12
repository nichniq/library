// =============================================================================
// ISBN utilities — pure functions, no DOM, no I/O.
// =============================================================================

// "9780374533557", " 0143039431 ", "978-0-06-093546-7" → ["9780374533557", …]
export const parse_isbns = (raw) =>
  raw
    .split(/[\s,]+/)
    .map((s) => s.replace(/[^0-9Xx]/g, "").toUpperCase())
    .filter((s) => s.length === 10 || s.length === 13);

// ISBN-10 → ISBN-13 by prefixing "978" and recomputing the EAN-13 check digit.
export const isbn10_to_13 = (isbn10) => {
  if (!isbn10 || isbn10.length !== 10) return null;
  const core = "978" + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(core[i], 10);
    if (Number.isNaN(digit)) return null;
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return core + check;
};

// ISBN-13 → ISBN-10. Only the 978 prefix has an ISBN-10 equivalent;
// 979-prefixed ISBN-13s return null.
export const isbn13_to_10 = (isbn13) => {
  if (!isbn13 || isbn13.length !== 13 || !isbn13.startsWith("978")) return null;
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const digit = parseInt(core[i], 10);
    if (Number.isNaN(digit)) return null;
    sum += digit * (10 - i);
  }
  const remainder = (11 - (sum % 11)) % 11;
  const check = remainder === 10 ? "X" : String(remainder);
  return core + check;
};
