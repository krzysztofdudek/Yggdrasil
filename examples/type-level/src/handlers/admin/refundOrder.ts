import { validate } from '../../lib/validate';
import { requireRole } from '../../lib/auth';

// Admin-only step: refund an order outside the normal checkout flow. On top
// of the input check every handler carries, a refund also needs a role check.
export function refundOrder(req: { actor: { roles: string[] }; body: { orderId?: string } }) {
  requireRole(req.actor, 'admin');
  validate(req.body, ['orderId']);
  return { refunded: true };
}
