ALTER TABLE public.stations
ADD COLUMN IF NOT EXISTS staff_create_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS
stations_staff_create_operation_lookup_idx
ON public.stations (
    staff_create_request_id,
    created_by_user_id
)
WHERE staff_create_request_id IS NOT NULL;

COMMENT ON COLUMN public.stations.staff_create_completed_at
IS 'Set after successful completion of staff listing creation';
