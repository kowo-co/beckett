import { tokenize } from "./tokenize.ts";

/** Title-cases input: each word capitalized, joined by single spaces. */
export function titleCase(input: string): string {
  return tokenize(input)
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
