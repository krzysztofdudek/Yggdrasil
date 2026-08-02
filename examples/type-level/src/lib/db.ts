// Minimal parameterized-query helper shared by every repository.
export async function query<T>(sql: string, params: unknown[]): Promise<T[]> {
  void sql;
  void params;
  return [];
}
