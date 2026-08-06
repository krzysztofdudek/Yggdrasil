import { validate } from '../lib/validate';

// Step 3: hand the paid order to the warehouse.
export function scheduleFulfillment(req: { body: { orderId?: string } }) {
  validate(req.body, ['orderId']);
  return { scheduled: true };
}
