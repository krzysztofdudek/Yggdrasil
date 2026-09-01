// UsersService — looks up users by id.

export interface User {
  id: string;
  name: string;
}

export class UsersService {
  private readonly users = new Map<string, User>();

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  addUser(user: User): void {
    this.users.set(user.id, user);
  }
}
