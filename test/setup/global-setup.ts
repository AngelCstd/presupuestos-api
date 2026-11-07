// test/setup/global-setup.ts
//
// Corre una vez antes de toda la suite de integración, sin importar cuál de
// los tres scripts se haya invocado (test:integration, :auth o :db).
// Por eso vive aquí y no en un hook `pretest:*` de npm: un hook específico
// no dispara si se invoca otro script, y el loop se saltaría el bootstrap
// sin darse cuenta.

import { applyAuthStub } from './apply-auth-stub';

export default async function globalSetup(): Promise<void> {
  await applyAuthStub();
}
