export class OrderRepository {
  private rows: string[] = [];

  add(value: string): void {
    this.rows.push("order:" + value);
  }

  findFirst(): string {
    return this.rows[0];
  }
}
