-- AUTODEAR STAFF CREATE IDEMPOTENCY V1
-- One creation request maps to at most one station.

ALTER TABLE public.stations
ADD COLUMN IF NOT EXISTS staff_create_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS
stations_staff_create_request_id_unique
ON public.stations (staff_create_request_id)
WHERE staff_create_request_id IS NOT NULL;

COMMENT ON COLUMN public.stations.staff_create_request_id
IS 'Unique creation operation ID for AUTODEAR staff listings';
