import { checkAge } from "./validate.ts";

export function canCheckout(age: number): boolean {
  return checkAge(age);
}
