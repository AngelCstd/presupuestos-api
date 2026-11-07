// test/jest-integration.config.js
//
// IMPORTANTE — rootDir explícito:
// Cuando Jest carga un config que NO está en la raíz del proyecto, `rootDir`
// por defecto es el directorio que contiene el config (aquí: `test/`).
// Sin esta línea, `<rootDir>/test/**/*.spec.ts` resolvería a
// `test/test/**/*.spec.ts` — cero tests encontrados, y la suite pasaría
// vacía en verde.
const path = require('path');

module.exports = {
  rootDir: path.resolve(__dirname, '..'),

  preset: 'ts-jest',
  testEnvironment: 'node',

  testMatch: ['<rootDir>/test/**/*.spec.ts'],

  globalSetup: '<rootDir>/test/setup/global-setup.ts',

  // `runInBand` NO es una opción válida de configuración — es flag de CLI.
  // El equivalente en config es `maxWorkers: 1`.
  maxWorkers: 1,

  // T-L03 corre `migrate reset` + `migrate deploy`, y los tests de
  // integración comparten una sola base: un timeout corto produce
  // fallos intermitentes que no son bugs de la implementación.
  testTimeout: 30_000,
};
