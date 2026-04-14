import { charge } from './payments.js';

export async function handleOrder(orderId: string, amount: number) {
  const result = await charge(orderId, amount);
  return { status: 'ok', transactionId: result.transactionId };
}
