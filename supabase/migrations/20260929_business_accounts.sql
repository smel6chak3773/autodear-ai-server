begin;

create extension if not exists "uuid-ossp";

create table if not exists public.business_accounts (
  id uuid primary key default uuid_generate_v4(),

  auth_user_id uuid not null
    references auth.users(id)
    on delete cascade,

  business_type text not null default 'self',

  business_name text not null,
  legal_name text,

  inn text,
  ogrn text,

  phone text,
  email text,
  city text,

  avatar_url text,

  status text not null default 'active',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint business_accounts_auth_user_unique
    unique (auth_user_id)
);

create index if not exists
  business_accounts_status_idx
on public.business_accounts(status);

comment on table public.business_accounts is
  'AUTODEAR business workspace. One Supabase Auth identity may have a personal profile and one business account. Stations are separate business listings/locations.';

comment on column public.business_accounts.auth_user_id is
  'Supabase Auth identity that owns this business account.';

alter table public.business_accounts
  enable row level security;

revoke all
on table public.business_accounts
from anon, authenticated;

grant
  select,
  insert,
  update,
  delete
on table public.business_accounts
to service_role;

insert into public.business_accounts (
  auth_user_id,
  business_type,
  business_name,
  legal_name,
  inn,
  ogrn,
  phone,
  email,
  city,
  avatar_url,
  status,
  created_at,
  updated_at
)
select
  legacy.auth_user_id,

  coalesce(
    nullif(legacy.business_type, ''),
    'self'
  ),

  coalesce(
    nullif(legacy.legal_name, ''),
    nullif(legacy.station_name, ''),
    nullif(legacy.profile_name, ''),
    'Бизнес AUTODEAR'
  ),

  coalesce(
    nullif(legacy.legal_name, ''),
    nullif(legacy.station_name, ''),
    nullif(legacy.profile_name, '')
  ),

  nullif(legacy.inn, ''),
  nullif(legacy.ogrn, ''),

  coalesce(
    nullif(legacy.station_phone, ''),
    nullif(legacy.profile_phone, '')
  ),

  coalesce(
    nullif(legacy.station_email, ''),
    nullif(legacy.profile_email, '')
  ),

  coalesce(
    nullif(legacy.station_city, ''),
    nullif(legacy.profile_city, '')
  ),

  coalesce(
    nullif(legacy.station_photo_url, ''),
    nullif(legacy.profile_avatar_url, '')
  ),

  'active',

  coalesce(
    legacy.profile_created_at,
    now()
  ),

  now()

from (
  select distinct on (
    coalesce(
      p.auth_user_id,
      p.id
    )
  )
    coalesce(
      p.auth_user_id,
      p.id
    ) as auth_user_id,

    p.name as profile_name,
    p.phone as profile_phone,
    p.email as profile_email,
    p.city as profile_city,
    p.avatar_url as profile_avatar_url,
    p.created_at as profile_created_at,

    s.name as station_name,
    s.legal_name,
    s.business_type,
    s.inn,
    s.ogrn,
    s.phone as station_phone,
    s.email as station_email,
    s.city as station_city,
    s.photo_url as station_photo_url

  from public.profiles p

  /*
   * BUSINESS_ACCOUNT_AUTH_OWNER_GUARD_V1
   *
   * Переносим только профиль, у которого
   * действительно существует Supabase Auth user.
   */
  inner join auth.users au
    on au.id =
      coalesce(
        p.auth_user_id,
        p.id
      )

  inner join public.stations s
    on (
      s.owner_id = p.auth_user_id::text
      or
      s.owner_id = p.id::text
    )

  where
    lower(
      coalesce(
        p.role,
        ''
      )
    ) = 'business'

  order by
    coalesce(
      p.auth_user_id,
      p.id
    ),
    s.created_at asc nulls last,
    s.id asc
) legacy

on conflict (auth_user_id)
do nothing;

commit;

select
  id,
  auth_user_id,
  business_type,
  business_name,
  legal_name,
  phone,
  email,
  city,
  status,
  created_at
from public.business_accounts
order by created_at;

select
  count(*) as business_accounts_count
from public.business_accounts;
