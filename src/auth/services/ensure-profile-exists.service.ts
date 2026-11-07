import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { ProfileDeletedException } from '../exceptions/profile-deleted.exception';

export interface ProfileRow {
  id: string;
  timezone: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawProfileRow {
  id: string;
  timezone: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  inserted: boolean;
}

/**
 * TASK-auth.md, "Mecánica de creación de profiles": upsert idempotente vía
 * SQL crudo — nunca prisma.profile.upsert(), que tocaría updated_at en
 * cada request autenticado sin cambios reales por el @updatedAt de Prisma.
 * `ON CONFLICT DO UPDATE SET id = EXCLUDED.id` (no-op de valor) es
 * necesario para que RETURNING sí entregue la fila en el caso de
 * conflicto — con DO NOTHING no habría fila que retornar.
 *
 * `(xmax = 0) AS inserted` — idioma estándar de Postgres para distinguir,
 * dentro del mismo RETURNING, si la fila devuelta vino de la rama INSERT
 * (xmax = 0, nunca expirada) o de la rama DO UPDATE del upsert (xmax ≠ 0,
 * la nueva versión de la fila quedó marcada por el UPDATE que la
 * produjo). Se usa para sembrar la cuenta de sistema (P-07 de
 * TASK-db.md, resuelto aquí; ARCHITECTURE.md §3.12) solo cuando esta
 * llamada de verdad creó la fila — nunca en la rama "ya existía", así el
 * mismo usuario autenticándose otra vez no vuelve a sembrar.
 *
 * Seed y upsert de `profiles` van en la MISMA transacción: un perfil sin
 * cuenta de sistema es un estado roto —
 * `POST /transactions/opening-balances` no puede funcionar sin ella, y
 * el usuario no puede crearla por su cuenta. Separar las dos escrituras
 * abriría una ventana donde eso pasa (perfil creado, seed pendiente, el
 * proceso muere entre medio). La concurrencia (T-7) se resuelve igual
 * que siempre: Postgres serializa el conflicto de la llave única de
 * `profiles`, así que de dos `ensure()` en paralelo para el mismo
 * usuario nuevo, solo una ve `inserted = true` y solo esa siembra.
 */
@Injectable()
export class EnsureProfileExistsService {
  constructor(private readonly prisma: PrismaClient) {}

  async ensure(userId: string): Promise<ProfileRow> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<RawProfileRow[]>`
        INSERT INTO profiles (id)
        VALUES (${userId}::uuid)
        ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        RETURNING id, timezone, deleted_at, created_at, updated_at, (xmax = 0) AS inserted
      `;
      const row = rows[0];

      if (row.deleted_at !== null) {
        // Rechazo explícito, sin reactivación (TASK-auth.md, PENDIENTE
        // resuelto): el UPDATE no-op de arriba ya corrió y no tocó
        // deleted_at, así que la fila queda exactamente como estaba.
        throw new ProfileDeletedException();
      }

      if (row.inserted) {
        await tx.$executeRaw`SELECT fn_seed_new_user(${userId}::uuid)`;
      }

      return {
        id: row.id,
        timezone: row.timezone,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }
}
