export class PaymentRepository {
  private rows: string[] = [];

  add(value: string): void {
    this.rows.push("payment:" + value);
  }

  findFirst(): string {
    return this.rows[0];
  }
}
