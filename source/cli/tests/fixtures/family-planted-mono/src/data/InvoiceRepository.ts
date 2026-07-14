export class InvoiceRepository {
  private rows: string[] = [];

  add(value: string): void {
    this.rows.push("invoice:" + value);
  }

  findFirst(): string {
    return this.rows[0];
  }
}
