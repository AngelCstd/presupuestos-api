CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  timezone    TEXT NOT NULL DEFAULT 'America/Mexico_City',
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profiles IS
  'Datos de negocio del usuario, 1:1 con auth.users. Sin columna de rol en esta fase (ARCHITECTURE.md §2). Fila creada por el backend con service_role, no por trigger.';
COMMENT ON COLUMN public.profiles.timezone IS
  'IANA timezone, usada para resolver el periodo presupuestal vigente de hoy.';
COMMENT ON COLUMN public.profiles.deleted_at IS
  'Soft delete. NULL = perfil activo. Todas las FK de la capa de datos hacia profiles.id son ON DELETE RESTRICT.';
COMMENT ON COLUMN public.profiles.updated_at IS
  'Actualizado por Prisma a nivel de aplicación, sin trigger — consistente con el resto del schema (ver ARCHITECTURE.md).';

CREATE INDEX idx_profiles_active ON public.profiles (id) WHERE deleted_at IS NULL;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Sin policy de INSERT ni DELETE para el usuario final: la fila la crea
-- el backend con service_role (ver TASK-auth.md, mecánica de creación).
