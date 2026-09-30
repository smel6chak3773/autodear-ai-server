-- AUTODEAR referral core
-- REFERRAL_CORE_V1
--
-- Server-side source of truth for:
-- 1. permanent referral code per canonical profile;
-- 2. immutable invited -> referrer relation;
-- 3. safe idempotent code creation.

create table if not exists public.user_referral_codes (
  profile_id uuid primary key
    references public.profiles(id)
    on delete cascade,

  code text not null unique,

  created_at timestamptz not null
    default now(),

  constraint user_referral_codes_code_format
    check (
      code ~ '^AD-[A-Z0-9]{8,32}$'
    )
);

create table if not exists public.user_referrals (
  invited_profile_id uuid primary key
    references public.profiles(id)
    on delete cascade,

  referrer_profile_id uuid not null
    references public.profiles(id)
    on delete restrict,

  referral_code text not null
    references public.user_referral_codes(code)
    on update cascade
    on delete restrict,

  created_at timestamptz not null
    default now(),

  constraint user_referrals_no_self
    check (
      invited_profile_id <>
      referrer_profile_id
    )
);

create index if not exists
  user_referrals_referrer_profile_id_idx
on public.user_referrals (
  referrer_profile_id
);

alter table public.user_referral_codes
  enable row level security;

alter table public.user_referrals
  enable row level security;

revoke all
on public.user_referral_codes
from anon, authenticated;

revoke all
on public.user_referrals
from anon, authenticated;


create or replace function
public.autodear_ensure_referral_code(
  p_profile_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_attempt integer := 0;
begin
  if p_profile_id is null then
    raise exception
      'PROFILE_ID_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = p_profile_id
  ) then
    raise exception
      'PROFILE_NOT_FOUND';
  end if;

  select c.code
  into v_code
  from public.user_referral_codes c
  where c.profile_id = p_profile_id;

  if v_code is not null then
    return v_code;
  end if;

  loop
    v_attempt := v_attempt + 1;

    if v_attempt > 10 then
      raise exception
        'REFERRAL_CODE_GENERATION_FAILED';
    end if;

    v_code :=
      'AD-' ||
      upper(
        substring(
          md5(
            p_profile_id::text ||
            ':' ||
            clock_timestamp()::text ||
            ':' ||
            random()::text
          )
          from 1 for 12
        )
      );

    begin
      insert into public.user_referral_codes (
        profile_id,
        code
      )
      values (
        p_profile_id,
        v_code
      );

      return v_code;

    exception
      when unique_violation then
        /*
         * Возможны два безопасных случая:
         * 1. параллельный запрос уже создал код
         *    для этого profile_id;
         * 2. крайне редкая коллизия самого code.
         */

        select c.code
        into v_code
        from public.user_referral_codes c
        where c.profile_id =
          p_profile_id;

        if v_code is not null then
          return v_code;
        end if;
    end;
  end loop;
end;
$$;

revoke all
on function
public.autodear_ensure_referral_code(uuid)
from public, anon, authenticated;

grant execute
on function
public.autodear_ensure_referral_code(uuid)
to service_role;
