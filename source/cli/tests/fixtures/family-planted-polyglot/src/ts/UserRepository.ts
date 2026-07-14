export class UserRepository {
  private rows: string[] = [];

  add(value: string): void {
    this.rows.push("user:" + value);
  }

  findFirst(): string {
    return this.rows[0];
  }
}
