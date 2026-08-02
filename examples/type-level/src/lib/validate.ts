// Minimal required-field validator shared by every handler.
export function validate(body: Record<string, unknown>, required: string[]): void {
  for (const field of required) {
    if (body[field] === undefined) {
      throw new Error(`missing required field: ${field}`);
    }
  }
}
