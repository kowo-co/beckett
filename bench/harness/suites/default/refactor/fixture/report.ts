import { procData, type Order } from "./orders.ts";

export function renderReport(orders: Order[]): string {
  const { count, total } = procData(orders);
  return `${count} orders, total ${total.toFixed(2)}`;
}
