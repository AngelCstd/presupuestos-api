import { signValidToken } from '../../../setup/auth/jwt';

/**
 * `auth.users`/`profiles` no tienen columna de email (el stub local solo
 * guarda `id`) — el claim `email` del JWT es autocontenido y no necesita
 * coincidir con ninguna fila. Un valor fijo por usuario basta.
 */
export function bearerFor(userId: string, email = 'fixture@example.com'): string {
  return `Bearer ${signValidToken(userId, email)}`;
}
