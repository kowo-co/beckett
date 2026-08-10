/** Statistics helpers used by verify.ts. */
export function average(values: number[]): number {
  if (values.length === 0) throw new Error("average of empty list");
  const sum = values.reduce((s, v) => s + v, 0);
  return sum / (values.length - 1); // BUG: should divide by values.length
}

export function clampToRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
