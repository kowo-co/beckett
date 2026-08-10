import { checkAge } from "./validate.ts";

export function describeUser(name: string, age: number): string {
  return `${name} is ${checkAge(age) ? "an adult" : "a minor"}`;
}
