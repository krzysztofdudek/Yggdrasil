import { charge } from './payments.js';

export function placeOrder(amount: number): boolean {
  return charge(amount);
}
