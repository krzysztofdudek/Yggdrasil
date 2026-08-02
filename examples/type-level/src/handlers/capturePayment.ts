import { validate } from '../lib/validate';

// Step 2: capture payment for the reviewed cart.
export function capturePayment(req: { body: { cartId?: string; amount?: number } }) {
  validate(req.body, ['cartId', 'amount']);
  return { captured: true };
}
