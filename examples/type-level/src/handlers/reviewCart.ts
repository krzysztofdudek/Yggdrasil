import { validate } from '../lib/validate';

// Step 1: the shopper reviews the cart before paying.
export function reviewCart(req: { body: { cartId?: string } }) {
  validate(req.body, ['cartId']);
  return { cartId: req.body.cartId, items: [] };
}
