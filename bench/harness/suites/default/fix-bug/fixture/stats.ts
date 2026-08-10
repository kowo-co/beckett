export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid]!;
}

export function mean(values: number[]): number {
  if (values.length === 0) throw new Error("mean of empty list");
  return values.reduce((s, v) => s + v, 0) / values.length;
}
