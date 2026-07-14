export class LegacyRepository {
  private rows: string[] = [];

  add(value: string): void {
    if (value.length > 0) {
      this.rows.push("legacy:" + value);
    }
  }

  findFirst(): string {
    return this.rows[0];
  }
}
