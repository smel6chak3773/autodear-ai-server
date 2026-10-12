-- AUTODEAR production guard:
-- technical diagnostic station names must never be persisted.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stations_no_autodear_diagnostic_names'
      AND conrelid = 'public.stations'::regclass
  ) THEN

    ALTER TABLE public.stations
      ADD CONSTRAINT stations_no_autodear_diagnostic_names
      CHECK (
        name IS NULL
        OR left(
          name,
          length('__AUTODEAR_DIAGNOSTIC__')
        ) <> '__AUTODEAR_DIAGNOSTIC__'
      );

  END IF;
END
$$;
