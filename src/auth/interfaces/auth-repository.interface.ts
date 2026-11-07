/**
 * TASK-auth.md, Entregables: "IAuthRepository (interfaz) —
 * validateToken(token: string): Promise<{ userId: string; email: string }>".
 */
export interface IAuthRepository {
  validateToken(token: string): Promise<{ userId: string; email: string }>;
}
