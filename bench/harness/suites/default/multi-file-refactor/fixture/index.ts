import { checkAge } from "./lib/validate.ts";
import { describeUser } from "./lib/user.ts";
import { canCheckout } from "./lib/order.ts";

export function summarize(name: string, age: number): string {
  const eligible = checkAge(age) ? "eligible" : "not eligible";
  return `${describeUser(name, age)}; checkout ${canCheckout(age) ? "allowed" : "blocked"}; ${eligible}`;
}
