import { average, clampToRange } from "./calc.ts";

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
}

assertEqual(average([2, 4, 6]), 4, "average of [2,4,6]");
assertEqual(average([10]), 10, "average of a single value");
assertEqual(clampToRange(15, 0, 10), 10, "clampToRange upper bound");
assertEqual(clampToRange(-5, 0, 10), 0, "clampToRange lower bound");

console.log("OK");
