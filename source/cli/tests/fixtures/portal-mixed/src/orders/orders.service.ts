// OrdersService — creates and reads orders, resolving the owning user.

import { UsersService } from '../users/users.service.js';

export interface Order {
  id: string;
  userId: string;
  total: number;
}

export class OrdersService {
  private readonly orders: Order[] = [];

  constructor(private readonly users: UsersService) {}

  createOrder(order: Order): Order {
    const user = this.users.getUser(order.userId);
    if (!user) {
      throw new Error(`unknown user ${order.userId}`);
    }
    this.orders.push(order);
    return order;
  }

  listOrders(): readonly Order[] {
    return this.orders;
  }
}
