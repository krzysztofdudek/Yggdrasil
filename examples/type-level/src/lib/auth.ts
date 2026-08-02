// Minimal role check shared by every admin-only handler.
export function requireRole(actor: { roles: string[] }, role: string): void {
  if (!actor.roles.includes(role)) {
    throw new Error(`actor lacks required role: ${role}`);
  }
}
