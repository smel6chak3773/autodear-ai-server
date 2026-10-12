begin;

create or replace function public.autodear_accept_business_ownership_transfer(
  p_transfer_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer
    public.business_ownership_transfers%rowtype;

  v_station record;

  v_business_account record;
begin

  if p_transfer_id is null
     or p_actor_user_id is null then

    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_INPUT_REQUIRED'
    );

  end if;


  /*
   * Блокируем конкретную заявку.
   * Принять её может только указанный
   * получатель и только пока она pending.
   */
  select *
  into v_transfer
  from public.business_ownership_transfers
  where id = p_transfer_id
    and to_owner_id = p_actor_user_id
    and status = 'pending'
  for update;


  if not found then

    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_NOT_FOUND_OR_ALREADY_RESPONDED'
    );

  end if;


  /*
   * Проверяем срок действия.
   * Если срок вышел — сразу фиксируем expired.
   */
  if v_transfer.expires_at <= now() then

    update public.business_ownership_transfers
    set
      status = 'expired',
      responded_at = now(),
      updated_at = now()
    where id = v_transfer.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_EXPIRED'
    );

  end if;


  /*
   * Блокируем саму бизнес-карточку.
   */
  select
    id,
    owner_id,
    is_active,
    ownership_status
  into v_station
  from public.stations
  where id = v_transfer.station_id
  for update;


  if not found then

    return jsonb_build_object(
      'ok', false,
      'error', 'BUSINESS_NOT_FOUND'
    );

  end if;


  /*
   * Удалённые / неактивные карточки
   * передавать нельзя.
   */
  if v_station.is_active is false then

    return jsonb_build_object(
      'ok', false,
      'error', 'BUSINESS_INACTIVE'
    );

  end if;


  /*
   * За это время текущий владелец
   * не должен был измениться.
   */
  if v_station.owner_id is distinct from
     v_transfer.from_owner_id::text then

    return jsonb_build_object(
      'ok', false,
      'error', 'BUSINESS_OWNER_CHANGED'
    );

  end if;


  /*
   * Получатель обязан иметь активный
   * бизнес-аккаунт одного из допустимых типов.
   */
  select
    id,
    auth_user_id,
    business_type,
    business_name,
    legal_name,
    inn,
    ogrn,
    status
  into v_business_account
  from public.business_accounts
  where auth_user_id = p_actor_user_id
    and status = 'active'
    and business_type in (
      'self',
      'ip',
      'ooo'
    )
  limit 1;


  if not found then

    return jsonb_build_object(
      'ok', false,
      'error', 'TARGET_BUSINESS_ACCOUNT_NOT_ELIGIBLE'
    );

  end if;


  /*
   * Меняем только ownership-поля.
   *
   * station.id НЕ меняется.
   * Фотографии, услуги, адрес, график,
   * отзывы, рейтинг, история и остальные
   * поля карточки остаются прежними.
   *
   * claimed_at намеренно НЕ меняем —
   * это историческая дата.
   */
  update public.stations
  set
    owner_id = p_actor_user_id::text,
    ownership_status = 'claimed',
    claimed_by_user_id = p_actor_user_id::text
  where id = v_transfer.station_id
    and owner_id =
      v_transfer.from_owner_id::text;


  if not found then

    return jsonb_build_object(
      'ok', false,
      'error', 'BUSINESS_OWNER_UPDATE_FAILED'
    );

  end if;


  /*
   * Заявка становится принятой.
   */
  update public.business_ownership_transfers
  set
    status = 'accepted',
    responded_at = now(),
    accepted_by_user_id = p_actor_user_id,
    updated_at = now()
  where id = v_transfer.id
    and status = 'pending';


  if not found then

    return jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_STATUS_UPDATE_FAILED'
    );

  end if;


  return jsonb_build_object(
    'ok', true,
    'status', 'accepted',
    'transferId', v_transfer.id,
    'stationId', v_transfer.station_id,
    'fromOwnerId', v_transfer.from_owner_id,
    'toOwnerId', v_transfer.to_owner_id
  );

end;
$$;


revoke all
on function public.autodear_accept_business_ownership_transfer(
  uuid,
  uuid
)
from public, anon, authenticated;

grant execute
on function public.autodear_accept_business_ownership_transfer(
  uuid,
  uuid
)
to service_role;


comment on function
public.autodear_accept_business_ownership_transfer(
  uuid,
  uuid
)
is
  'Атомарное принятие передачи уже принадлежащей бизнес-карточки. Не является claim-flow.';


commit;
