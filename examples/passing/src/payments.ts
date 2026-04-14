import { emitAudit } from './audit.js';

export async function charge(orderId: string, amount: number) {
  // Process the payment
  const transactionId = `txn_${Date.now()}`;

  emitAudit({
    operation: 'charge',
    timestamp: new Date().toISOString(),
    entityId: orderId,
    amount,
    transactionId,
  });

  return { transactionId };
}

export async function refund(transactionId: string, amount: number) {
  // Process the refund

  emitAudit({
    operation: 'refund',
    timestamp: new Date().toISOString(),
    entityId: transactionId,
    amount,
  });

  return { status: 'refunded' };
}
