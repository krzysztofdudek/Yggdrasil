import { query } from '../lib/db';

interface Order {
  id: string;
  total: number;
}

export async function findOrder(id: string): Promise<Order | undefined> {
  const rows = await query<Order>('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0];
}

export async function insertOrder(order: Order): Promise<void> {
  await query('INSERT INTO orders (id, total) VALUES ($1, $2)', [order.id, order.total]);
}
