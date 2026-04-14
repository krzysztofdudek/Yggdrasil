export async function charge(orderId: string, amount: number) {
  // Process the payment
  const transactionId = `txn_${Date.now()}`;
  console.log(`Charged ${amount} for order ${orderId}`);
  return { transactionId };
}

export async function refund(transactionId: string, amount: number) {
  // Process the refund
  console.log(`Refunded ${amount} for transaction ${transactionId}`);
  return { status: 'refunded' };
}
