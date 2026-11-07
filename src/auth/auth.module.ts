import { Module } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { SupabaseAuthRepository } from './repositories/supabase-auth.repository';
import { AuthGuard } from './guards/auth.guard';

/**
 * TASK-api.md §13/T-R05 — los módulos de dominio importan `AuthModule`
 * para que `AuthGuard` (aplicado por ruta con `@UseGuards`) resuelva
 * `IAuthRepository` por DI. Quedó sin construir al cerrar TASK-auth
 * porque ningún test lo necesitaba todavía (ver PROGRESS.md) — ahora sí.
 *
 * `JwtKeyGetter` — el JWKS remoto del proyecto real de Supabase, vía
 * `createRemoteJWKSet` (caché + cooldown + búsqueda por `kid` con los
 * defaults de `jose`, ver PROGRESS.md/propuesta JWKS). En test, el
 * arnés lo sobreescribe con `createLocalJWKSet` — nunca red.
 */
function buildJwtKeyGetter(): JWTVerifyGetKey {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error('SUPABASE_URL no está definido');
  }
  return createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl));
}

@Module({
  providers: [
    { provide: 'IAuthRepository', useClass: SupabaseAuthRepository },
    { provide: 'JwtKeyGetter', useFactory: buildJwtKeyGetter },
    AuthGuard,
  ],
  exports: ['IAuthRepository', AuthGuard],
})
export class AuthModule {}
