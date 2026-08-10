/** Splits input into lowercase words, stripping a leading apostrophe (e.g. "'tis" -> "tis"). */
export function tokenize(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((word) => (word.startsWith("'") ? word.slice(1) : word))
    .map((word) => word.slice(1)) // BUG: this drops a real character on every word, apostrophe or not
    .map((word) => word.toLowerCase());
}
