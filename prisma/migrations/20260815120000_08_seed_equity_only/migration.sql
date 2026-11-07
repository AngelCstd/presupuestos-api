-- U21 revisado (TASK-db.md §3, fila 08; ARCHITECTURE.md §3.12) — el seed
-- automático se reduce a la cuenta de sistema. Decisión de Luis
-- (PROGRESS.md): las 7 categorías y la fuente de ingreso "Sueldo" son
-- opinión, no infraestructura — pasan a ser una lista sugerida que
-- presenta el frontend en el onboarding, creada con los endpoints
-- normales (POST /categories, POST /income-sources). La cuenta de
-- sistema sí se queda: es infraestructura — sin ella
-- POST /transactions/opening-balances no funciona, y el usuario no
-- puede crearla por su cuenta (`equity` no es un `kind` direccionable
-- desde la API; un accountId con is_system=true se rechaza con 403).
--
-- CREATE OR REPLACE conserva el nombre y la firma de la migración 07
-- (fn_seed_new_user(uuid)) — nada que dependa de ese nombre necesita
-- cambiar. No se edita la migración 07 ya aplicada (TASK-db.md §7: una
-- migración aplicada no se toca).
CREATE OR REPLACE FUNCTION fn_seed_new_user(p_user_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO accounts (id, user_id, name, type, rollover_type, is_system)
  VALUES (gen_random_uuid(), p_user_id, 'Saldo Inicial', 'equity', NULL, true)
  ON CONFLICT (user_id, lower(name)) WHERE archived_at IS NULL DO NOTHING;
END;
$$;
