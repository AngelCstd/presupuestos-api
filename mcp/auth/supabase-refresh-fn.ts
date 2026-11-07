import { createClient } from '@supabase/supabase-js';
import type { RefreshFn, RefreshedSession } from './token-refresh.service';

/**
 * TASK-auth.md, "Inyección de la función de refresh": la única pieza del
 * módulo de refresh del MCP que toca el SDK de Supabase. `McpTokenRefreshService`
 * no lo conoce — solo recibe una `RefreshFn`.
 */
export const createSupabaseRefreshFn = (url: string, anonKey: string): RefreshFn => {
  const client = createClient(url, anonKey);

  return async (refreshToken: string): Promise<RefreshedSession> => {
    const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data.session) {
      throw error ?? new Error('Supabase refreshSession no devolvió una sesión');
    }

    const { access_token: accessToken, expires_at: expiresAtSeconds, expires_in: expiresInSeconds } = data.session;

    // Conversión de unidades — TASK-auth.md, "Contrato del módulo de
    // refresh de token del MCP": Supabase devuelve `expires_in` en
    // SEGUNDOS (duración relativa, siempre presente) o `expires_at` en
    // epoch SEGUNDOS (timestamp absoluto, opcional). `RefreshedSession.expiresAt`
    // es epoch MILISEGUNDOS. Se prefiere `expires_at` cuando está
    // presente (absoluto, no acumula el error de "cuánto tardó el round
    // trip" que sí tiene derivar de `expires_in` + `Date.now()`).
    //
    // ⚠️ NO CUBIERTO POR NINGÚN TEST. Los tests #14-#16
    // (test/unit/mcp-token-refresh.spec.ts) inyectan una RefreshFn
    // mockeada que ya devuelve `expiresAt` en ms directamente — nunca
    // ejercen esta conversión. Si el `* 1000` se pierde aquí, el fallo es
    // silencioso: el token se considera expirado desde el primer segundo
    // (`this.now() < cached.expiresAt - skewMs` es falso casi de
    // inmediato) y el MCP refresca en cada llamada a getAccessToken(),
    // sin ningún error visible ni log — solo más tráfico del que debería
    // haber. Revisar en code review, no confiar en la suite.
    const expiresAt =
      expiresAtSeconds != null ? expiresAtSeconds * 1000 : Date.now() + expiresInSeconds * 1000;

    return { accessToken, expiresAt };
  };
};
