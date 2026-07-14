export class ProductRepository {
  private rows: string[] = [];

  add(value: string): void {
    this.rows.push("product:" + value);
  }

  findFirst(): string {
    return this.rows[0];
  }
}
