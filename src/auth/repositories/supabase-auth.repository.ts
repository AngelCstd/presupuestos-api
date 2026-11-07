import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { IAuthRepository } from '../interfaces/auth-repository.interface';

/**
 * Valida JWTs de Supabase localmente contra el JWKS del proyecto —
 * llaves públicas asimétricas, no un secret compartido (TASK-auth.md,
 * Entregables; migración de HS256 documentada en ARCHITECTURE.md §4,
 * verificada empíricamente con Luis: el proyecto real usa JWT Signing
 * Keys, ES256, y el "Legacy JWT Secret" solo verifica API keys, nunca
 * tokens de usuario). No traduce errores a excepciones HTTP — esa
 * responsabilidad es de AuthGuard (TASK-auth.md: "AuthGuard...
 * Responsabilidad única: validar token"). Cualquier fallo de
 * `jwtVerify` (firma inválida, expirado, kid desconocido, claims
 * faltantes, fetch del JWKS fallido) se propaga tal cual — incluido el
 * caso de fetch fallido, que se deja fallar cerrado a propósito (sin
 * fallback a caché vieja): es el comportamiento por default de `jose`,
 * sin código propio, ver `jwks-verification.integration.spec.ts`.
 *
 * `getKey` se inyecta por constructor (`'JwtKeyGetter'`), nunca se
 * construye aquí dentro: en producción es `createRemoteJWKSet` contra
 * el proyecto real (`AuthModule`); en test es `createLocalJWKSet` con
 * un JWKS estático, sin red.
 */
@Injectable()
export class SupabaseAuthRepository implements IAuthRepository {
  constructor(@Inject('JwtKeyGetter') private readonly getKey: JWTVerifyGetKey) {}

  async validateToken(token: string): Promise<{ userId: string; email: string }> {
    const { payload } = await jwtVerify(token, this.getKey, { algorithms: ['ES256'] });

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new Error('Token válido pero sin los claims requeridos (sub, email)');
    }

    return { userId: payload.sub, email: payload.email };
  }
}
