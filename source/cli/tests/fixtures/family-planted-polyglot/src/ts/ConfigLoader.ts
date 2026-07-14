export class ConfigLoader {
  private data: Record<string, string> = {};

  load(name: string): string {
    if (this.data[name]) {
      return this.data[name];
    }
    this.data[name] = "value:" + name;
    return this.data[name];
  }
}
