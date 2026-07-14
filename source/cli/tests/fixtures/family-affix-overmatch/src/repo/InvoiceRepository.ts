export class InvoiceRepository {
  private rows: string[] = [];

  add(value: string): void {
    this.rows.push("row:" + value);
  }

  findFirst(): string {
    return this.rows[0];
  }
}
