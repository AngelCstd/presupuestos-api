// `mcp/auth/token-refresh.service.ts` y `mcp/auth/mcp-refresh-failed.exception.ts`
// no existen todavía (TASK-auth.md, "Contrato del módulo de refresh de
// token del MCP"). Se cargan con `require()` dentro de `beforeAll`, no con
// `import` estático: un import estático a un módulo inexistente rompe la
// COMPILACIÓN de todo el archivo, y Jest reporta la suite entera como
// "failed to run" con 0 tests — no 3 tests en rojo, que es lo que pide la
// condición de paro (`npm run test:unit` → 13 tests, 3 en rojo). Con
// `require()` en `beforeAll`, el archivo compila, los 3 `it()` se
// registran, y el fallo ocurre en tiempo de ejecución — Jest lo atribuye a
// cada test del describe individualmente.

interface RefreshedSession {
  accessToken: string;
  expiresAt: number;
}
type RefreshFn = (refreshToken: string) => Promise<RefreshedSession>;

interface McpTokenRefreshServiceCtor {
  new (
    refreshFn: RefreshFn,
    refreshToken: string,
    now?: () => number,
    skewMs?: number,
  ): { getAccessToken(): Promise<string> };
}

const REFRESH_TOKEN = 'env-refresh-token';
const SKEW_MS = 60_000;

describe('McpTokenRefreshService — mcp-token-refresh.spec.ts (Grupo MCP, unit)', () => {
  let McpTokenRefreshService: McpTokenRefreshServiceCtor;
  let McpRefreshFailedException: new (cause: unknown) => Error;

  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    McpTokenRefreshService = require('../../mcp/auth/token-refresh.service').McpTokenRefreshService;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    McpRefreshFailedException =
      require('../../mcp/auth/mcp-refresh-failed.exception').McpRefreshFailedException;
  });

  it('T-14: token vigente → segunda llamada no dispara refreshFn, mismo access token', async () => {
    let now = 0;
    const refreshFn: RefreshFn = jest.fn(async () => ({ accessToken: 'token-1', expiresAt: now + 3_600_000 }));
    const service = new McpTokenRefreshService(refreshFn, REFRESH_TOKEN, () => now, SKEW_MS);

    const first = await service.getAccessToken();

    // Sigue dentro de la vigencia (expiresAt - skewMs todavía no se alcanza).
    now += 1_000;
    const second = await service.getAccessToken();

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(first).toBe('token-1');
    expect(second).toBe('token-1');
  });

  it('T-15: token vencido/ausente → segunda llamada sí refresca, con el mismo refreshToken de entorno', async () => {
    let now = 0;
    const refreshFn = jest
      .fn<ReturnType<RefreshFn>, Parameters<RefreshFn>>()
      .mockResolvedValueOnce({ accessToken: 'token-1', expiresAt: 3_600_000 })
      .mockResolvedValueOnce({ accessToken: 'token-2', expiresAt: 7_200_000 });
    const service = new McpTokenRefreshService(refreshFn, REFRESH_TOKEN, () => now, SKEW_MS);

    const first = await service.getAccessToken();

    // Más allá de expiresAt - skewMs (3_600_000 - 60_000).
    now = 3_600_000 - SKEW_MS + 1;
    const second = await service.getAccessToken();

    expect(refreshFn).toHaveBeenCalledTimes(2);
    expect(refreshFn).toHaveBeenNthCalledWith(1, REFRESH_TOKEN);
    expect(refreshFn).toHaveBeenNthCalledWith(2, REFRESH_TOKEN);
    expect(first).toBe('token-1');
    expect(second).toBe('token-2');
  });

  it('T-16: refreshFn rechaza → McpRefreshFailedException, refreshFn llamada exactamente una vez, sin reintento', async () => {
    const cause = new Error('refresh token inválido o revocado');
    const refreshFn: RefreshFn = jest.fn(async () => {
      throw cause;
    });
    const service = new McpTokenRefreshService(refreshFn, REFRESH_TOKEN, () => 0, SKEW_MS);

    await expect(service.getAccessToken()).rejects.toBeInstanceOf(McpRefreshFailedException);

    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});
