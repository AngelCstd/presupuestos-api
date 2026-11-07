import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

interface RecurringTemplateParams {
  id?: string;
  userId: string;
  name: string;
  accountId?: string | null;
  categoryId: string;
  amountCents: number;
  dayOfMonth: number;
  nextDueOn: string;
  lastConfirmedOn?: string | null;
  isActive?: boolean;
}

/**
 * INSERT directo — `recurring_templates` ya existe desde `TASK-db.md`
 * (migración `02f_recurring_templates`), pero `RecurringModule` (A09) no
 * existe todavía, así que no hay `POST /recurring-templates` real con el
 * que sembrar el fixture de T-S12.
 */
export async function insertRecurringTemplate(client: PoolClient, params: RecurringTemplateParams): Promise<string> {
  const id = params.id ?? randomUUID();
  await client.query(
    `INSERT INTO recurring_templates
       (id, user_id, name, account_id, category_id, amount_cents, day_of_month, next_due_on, last_confirmed_on, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.userId,
      params.name,
      params.accountId ?? null,
      params.categoryId,
      params.amountCents,
      params.dayOfMonth,
      params.nextDueOn,
      params.lastConfirmedOn ?? null,
      params.isActive ?? true,
    ],
  );
  return id;
}
