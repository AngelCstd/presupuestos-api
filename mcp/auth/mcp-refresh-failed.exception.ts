// TASK-auth.md, "Contrato del módulo de refresh de token del MCP" —
// "Qué pasa si el refresh falla": propagación con excepción tipada, sin
// reintento automático.
export class McpRefreshFailedException extends Error {
  constructor(readonly cause: unknown) {
    super('MCP refresh token inválido o revocado; se requiere reconexión manual');
  }
}
