export interface Order {
  id: string;
  quantity: number;
  unitPrice: number;
}

export function procData(orders: Order[]): { count: number; total: number } {
  let total = 0;
  for (const o of orders) total += o.quantity * o.unitPrice;
  return { count: orders.length, total };
}
