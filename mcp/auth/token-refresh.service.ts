import { McpRefreshFailedException } from './mcp-refresh-failed.exception';

export interface RefreshedSession {
  accessToken: string;
  /** Instante absoluto de expiración del access token, en epoch ms. */
  expiresAt: number;
}

/** Función que ejecuta el refresh real contra Supabase. Inyectada para ser mockeable. */
export type RefreshFn = (refreshToken: string) => Promise<RefreshedSession>;

/**
 * TASK-auth.md, "Contrato del módulo de refresh de token del MCP". Cache en
 * memoria del proceso, un solo campo privado — sin Redis, sin disco. Sin
 * deduplicación de promesa en vuelo (aceptado explícitamente: proceso de
 * un solo usuario, sin concurrencia real).
 */
export class McpTokenRefreshService {
  private cached: RefreshedSession | null = null;

  constructor(
    private readonly refreshFn: RefreshFn,
    private readonly refreshToken: string,
    private readonly now: () => number = () => Date.now(),
    private readonly skewMs: number = 60_000,
  ) {}

  /**
   * Devuelve un access token vigente. Si el cacheado sigue vigente (con
   * margen de `skewMs`), lo devuelve sin llamar a `refreshFn`. Si no,
   * refresca, actualiza el cache y devuelve el nuevo.
   */
  async getAccessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - this.skewMs) {
      return this.cached.accessToken;
    }

    let session: RefreshedSession;
    try {
      session = await this.refreshFn(this.refreshToken);
    } catch (cause) {
      // El cache NO se toca en caso de fallo (TASK-auth.md) — ni se
      // actualiza ni se limpia; no hay estado que invalidar aquí.
      throw new McpRefreshFailedException(cause);
    }

    this.cached = session;
    return this.cached.accessToken;
  }
}
