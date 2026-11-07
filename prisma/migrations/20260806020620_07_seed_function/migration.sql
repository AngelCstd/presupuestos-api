-- U21 — fn_seed_new_user (TASK-db.md §3, fila 07; ARCHITECTURE.md §3.12).
-- Al final a propósito: inserta filas reales, después de que existan
-- todos los CHECKs de 02a. Idempotente vía el mismo índice único parcial
-- que ya usa `accounts` (accounts_user_name_active_uniq). NO siembra
-- cuentas reales (asset/liability/receivable) — eso es onboarding,
-- fuera de esta capa.
CREATE FUNCTION fn_seed_new_user(p_user_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO accounts (id, user_id, name, type, rollover_type, is_system)
  VALUES
    (gen_random_uuid(), p_user_id, 'Comida',        'expense', 'reset',      false),
    (gen_random_uuid(), p_user_id, 'Transporte',    'expense', 'reset',      false),
    (gen_random_uuid(), p_user_id, 'Servicios',     'expense', 'accumulate', false),
    (gen_random_uuid(), p_user_id, 'Hogar',         'expense', 'reset',      false),
    (gen_random_uuid(), p_user_id, 'Salud',         'expense', 'accumulate', false),
    (gen_random_uuid(), p_user_id, 'Personal',      'expense', 'reset',      false),
    (gen_random_uuid(), p_user_id, 'Ahorro',        'expense', 'accumulate', false),
    (gen_random_uuid(), p_user_id, 'Sueldo',        'income',  NULL,         false),
    (gen_random_uuid(), p_user_id, 'Saldo Inicial', 'equity',  NULL,         true)
  ON CONFLICT (user_id, lower(name)) WHERE archived_at IS NULL DO NOTHING;
END;
$$;
