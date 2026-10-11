
begin;

create or replace function public.autodear_reject_business_ownership_transfer(
  p_transfer_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transfer public.business_ownership_transfers%rowtype;
  v_now timestamptz := now();
begin
  if p_transfer_id is null or p_actor_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_INPUT_REQUIRED'
    );
  end if;

  select *
  into v_transfer
  from public.business_ownership_transfers
  where id = p_transfer_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_NOT_FOUND_OR_ALREADY_RESPONDED'
    );
  end if;

  if v_transfer.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_NOT_FOUND_OR_ALREADY_RESPONDED',
      'status', v_transfer.status
    );
  end if;

  if v_transfer.expires_at <= v_now then
    update public.business_ownership_transfers
    set
      status = 'expired',
      responded_at = coalesce(responded_at, v_now),
      updated_at = v_now
    where id = v_transfer.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_EXPIRED',
      'transferId', v_transfer.id,
      'status', 'expired'
    );
  end if;

  if v_transfer.to_owner_id <> p_actor_user_id then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_RECIPIENT_REQUIRED'
    );
  end if;

  update public.business_ownership_transfers
  set
    status = 'rejected',
    rejected_by_user_id = p_actor_user_id,
    responded_at = v_now,
    updated_at = v_now
  where id = v_transfer.id;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_STATUS_UPDATE_FAILED'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'rejected',
    'transferId', v_transfer.id,
    'stationId', v_transfer.station_id,
    'fromOwnerId', v_transfer.from_owner_id,
    'toOwnerId', v_transfer.to_owner_id
  );
end;
$$;


create or replace function public.autodear_cancel_business_ownership_transfer(
  p_transfer_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transfer public.business_ownership_transfers%rowtype;
  v_now timestamptz := now();
begin
  if p_transfer_id is null or p_actor_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_INPUT_REQUIRED'
    );
  end if;

  select *
  into v_transfer
  from public.business_ownership_transfers
  where id = p_transfer_id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_NOT_FOUND_OR_ALREADY_RESPONDED'
    );
  end if;

  if v_transfer.status <> 'pending' then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_NOT_FOUND_OR_ALREADY_RESPONDED',
      'status', v_transfer.status
    );
  end if;

  if v_transfer.expires_at <= v_now then
    update public.business_ownership_transfers
    set
      status = 'expired',
      responded_at = coalesce(responded_at, v_now),
      updated_at = v_now
    where id = v_transfer.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_EXPIRED',
      'transferId', v_transfer.id,
      'status', 'expired'
    );
  end if;

  if v_transfer.from_owner_id <> p_actor_user_id then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_OWNER_REQUIRED'
    );
  end if;

  update public.business_ownership_transfers
  set
    status = 'cancelled',
    cancelled_by_user_id = p_actor_user_id,
    responded_at = v_now,
    updated_at = v_now
  where id = v_transfer.id;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_STATUS_UPDATE_FAILED'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'cancelled',
    'transferId', v_transfer.id,
    'stationId', v_transfer.station_id,
    'fromOwnerId', v_transfer.from_owner_id,
    'toOwnerId', v_transfer.to_owner_id
  );
end;
$$;


create or replace function public.autodear_expire_business_ownership_transfers()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  update public.business_ownership_transfers
  set
    status = 'expired',
    responded_at = coalesce(responded_at, now()),
    updated_at = now()
  where
    status = 'pending'
    and expires_at <= now();

  get diagnostics v_count = row_count;

  return v_count;
end;
$$;


revoke all
on function public.autodear_accept_business_ownership_transfer(uuid, uuid)
from public, anon, authenticated;

grant execute
on function public.autodear_accept_business_ownership_transfer(uuid, uuid)
to service_role;


revoke all
on function public.autodear_reject_business_ownership_transfer(uuid, uuid)
from public, anon, authenticated;

grant execute
on function public.autodear_reject_business_ownership_transfer(uuid, uuid)
to service_role;


revoke all
on function public.autodear_cancel_business_ownership_transfer(uuid, uuid)
from public, anon, authenticated;

grant execute
on function public.autodear_cancel_business_ownership_transfer(uuid, uuid)
to service_role;


revoke all
on function public.autodear_expire_business_ownership_transfers()
from public, anon, authenticated;

grant execute
on function public.autodear_expire_business_ownership_transfers()
to service_role;

commit;
