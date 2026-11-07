-- test/setup/local-auth-stub.sql
-- Bootstrap mínimo de Supabase Auth para Postgres puro (Docker local).
-- NO se ejecuta contra Supabase real — solo contra el contenedor de tests.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- Roles que Supabase provisiona automáticamente en cada proyecto y que
-- las policies de RLS (ARCHITECTURE.md §3.8) referencian con `TO
-- authenticated` — no existen en un Postgres local plano. Los roles son
-- a nivel de CLUSTER, no de base de datos, por eso el IF NOT EXISTS: es
-- lo más cercano a "CREATE ROLE IF NOT EXISTS" (que Postgres no soporta
-- directamente) y hace el bloque seguro de re-correr. NUNCA se ejecuta
-- contra Supabase real (igual que el resto de este archivo) — ahí ya
-- existen.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;