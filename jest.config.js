/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  // TASK-api.md §14: los unitarios puros de builders/validadores/errores
  // viven junto al código en `src/`, no en `test/unit/` — sin el segundo
  // patrón, `test:unit` nunca los encuentra. Acotado a `test/unit/`
  // (no `test/**`) para no recoger `test/integration/**`, que usa su
  // propia config (`test/jest-integration.config.js`, con globalSetup y
  // Postgres real) y correría sin ninguno de los dos.
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts', '<rootDir>/src/**/*.spec.ts'],
  // T-L03 corre `migrate reset` + `migrate deploy`, y los tests de
  // integración comparten una sola base (--runInBand): un timeout corto
  // produce fallos intermitentes que no son bugs de la implementación.
  testTimeout: 30_000,
};
