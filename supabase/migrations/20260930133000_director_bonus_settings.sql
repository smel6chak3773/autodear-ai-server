-- ============================================================
-- AUTODEAR — DIRECTOR BONUS / MONETIZATION SETTINGS
--
-- Single server-side source of truth for the director screen
-- "Бонусы и акции".
--
-- IMPORTANT:
-- - clients must not write this table directly;
-- - all writes go through trusted backend + service_role;
-- - bonuses ledger remains immutable and separate;
-- - service_cashback_percent is retained temporarily only for
--   compatibility with legacy QR / STO logic.
-- ============================================================


create table if not exists
public.director_bonus_settings (
  id text primary key,

  referral_bonus bigint not null default 100,
  registration_bonus bigint not null default 50,

  user_revenue_cashback_percent numeric not null default 10,
  referrer_revenue_percent numeric not null default 5,

  max_bonus_payment_percent numeric not null default 20,

  bonus_lifetime_days integer not null default 365,

  max_deal_bonus bigint not null default 250,
  max_deal_bonus_revenue_percent numeric not null default 25,

  review_bonus bigint not null default 20,

  first_booking_bonus bigint not null default 150,
  qr_visit_bonus bigint not null default 75,

  personal_premium_cashback_percent numeric not null default 5,
  personal_premium_referral_percent numeric not null default 5,

  business_premium_cashback_percent numeric not null default 5,
  business_premium_referral_percent numeric not null default 5,

  -- Legacy compatibility.
  -- Remove after every QR/STO reward path uses the
  -- AUTODEAR revenue-based server model.
  service_cashback_percent numeric not null default 5,

  premium_monthly_price bigint not null default 299,
  premium_yearly_price bigint not null default 2691,

  subscriptions_enabled boolean not null default false,

  free_cars_limit integer not null default 1,
  premium_cars_limit integer not null default 3,
  super_premium_cars_limit integer not null default 5,

  super_premium_monthly_price bigint not null default 399,
  super_premium_yearly_price bigint not null default 3591,

  yearly_discount_percent numeric not null default 25,

  premium_benefits_enabled boolean not null default true,
  super_premium_benefits_enabled boolean not null default true,

  dashboard_paywall_enabled boolean not null default false,

  damage_assessment_enabled boolean not null default true,
  smart_purchase_check_enabled boolean not null default true,
  osago_premium_feature_enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  updated_by_user_id uuid null,

  constraint director_bonus_settings_singleton_check
    check (id = 'global'),

  constraint director_bonus_settings_referral_bonus_check
    check (referral_bonus >= 0),

  constraint director_bonus_settings_registration_bonus_check
    check (registration_bonus >= 0),

  constraint director_bonus_settings_user_revenue_percent_check
    check (
      user_revenue_cashback_percent >= 0
      and
      user_revenue_cashback_percent <= 100
    ),

  constraint director_bonus_settings_referrer_revenue_percent_check
    check (
      referrer_revenue_percent >= 0
      and
      referrer_revenue_percent <= 100
    ),

  constraint director_bonus_settings_max_payment_percent_check
    check (
      max_bonus_payment_percent >= 0
      and
      max_bonus_payment_percent <= 100
    ),

  constraint director_bonus_settings_lifetime_check
    check (
      bonus_lifetime_days >= 1
      and
      bonus_lifetime_days <= 3650
    ),

  constraint director_bonus_settings_max_deal_bonus_check
    check (max_deal_bonus >= 0),

  constraint director_bonus_settings_max_deal_revenue_percent_check
    check (
      max_deal_bonus_revenue_percent >= 0
      and
      max_deal_bonus_revenue_percent <= 100
    ),

  constraint director_bonus_settings_review_bonus_check
    check (review_bonus >= 0),

  constraint director_bonus_settings_first_booking_bonus_check
    check (first_booking_bonus >= 0),

  constraint director_bonus_settings_qr_visit_bonus_check
    check (qr_visit_bonus >= 0),

  constraint director_bonus_settings_personal_premium_cashback_check
    check (
      personal_premium_cashback_percent >= 0
      and
      personal_premium_cashback_percent <= 100
    ),

  constraint director_bonus_settings_personal_premium_referral_check
    check (
      personal_premium_referral_percent >= 0
      and
      personal_premium_referral_percent <= 100
    ),

  constraint director_bonus_settings_business_premium_cashback_check
    check (
      business_premium_cashback_percent >= 0
      and
      business_premium_cashback_percent <= 100
    ),

  constraint director_bonus_settings_business_premium_referral_check
    check (
      business_premium_referral_percent >= 0
      and
      business_premium_referral_percent <= 100
    ),

  constraint director_bonus_settings_service_cashback_check
    check (
      service_cashback_percent >= 0
      and
      service_cashback_percent <= 100
    ),

  constraint director_bonus_settings_premium_monthly_price_check
    check (premium_monthly_price >= 0),

  constraint director_bonus_settings_premium_yearly_price_check
    check (premium_yearly_price >= 0),

  constraint director_bonus_settings_free_cars_limit_check
    check (free_cars_limit >= 1),

  constraint director_bonus_settings_premium_cars_limit_check
    check (premium_cars_limit >= 1),

  constraint director_bonus_settings_super_premium_cars_limit_check
    check (super_premium_cars_limit >= 1),

  constraint director_bonus_settings_super_premium_monthly_price_check
    check (super_premium_monthly_price >= 0),

  constraint director_bonus_settings_super_premium_yearly_price_check
    check (super_premium_yearly_price >= 0),

  constraint director_bonus_settings_yearly_discount_check
    check (
      yearly_discount_percent >= 0
      and
      yearly_discount_percent <= 100
    )
);


create or replace function
public.touch_director_bonus_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();

  return new;
end;
$$;


drop trigger if exists
director_bonus_settings_touch_updated_at
on public.director_bonus_settings;


create trigger
director_bonus_settings_touch_updated_at
before update
on public.director_bonus_settings
for each row
execute function
public.touch_director_bonus_settings_updated_at();


insert into
public.director_bonus_settings (
  id,

  referral_bonus,
  registration_bonus,

  user_revenue_cashback_percent,
  referrer_revenue_percent,

  max_bonus_payment_percent,
  bonus_lifetime_days,

  max_deal_bonus,
  max_deal_bonus_revenue_percent,

  review_bonus,

  first_booking_bonus,
  qr_visit_bonus,

  personal_premium_cashback_percent,
  personal_premium_referral_percent,

  business_premium_cashback_percent,
  business_premium_referral_percent,

  service_cashback_percent,

  premium_monthly_price,
  premium_yearly_price,

  subscriptions_enabled,

  free_cars_limit,
  premium_cars_limit,
  super_premium_cars_limit,

  super_premium_monthly_price,
  super_premium_yearly_price,

  yearly_discount_percent,

  premium_benefits_enabled,
  super_premium_benefits_enabled,

  dashboard_paywall_enabled,

  damage_assessment_enabled,
  smart_purchase_check_enabled,
  osago_premium_feature_enabled
)
values (
  'global',

  100,
  50,

  10,
  5,

  20,
  365,

  250,
  25,

  20,

  150,
  75,

  5,
  5,

  5,
  5,

  5,

  299,
  2691,

  false,

  1,
  3,
  5,

  399,
  3591,

  25,

  true,
  true,

  false,

  true,
  true,
  true
)
on conflict (id)
do nothing;


alter table
public.director_bonus_settings
enable row level security;


revoke all
on table public.director_bonus_settings
from anon;


revoke all
on table public.director_bonus_settings
from authenticated;


grant all
on table public.director_bonus_settings
to service_role;


revoke all
on function
public.touch_director_bonus_settings_updated_at()
from public;


grant execute
on function
public.touch_director_bonus_settings_updated_at()
to service_role;

-- ============================================================
-- RELEASE BONUS ECONOMY GATES
--
-- Первый публичный релиз:
-- фиксированные бонусы копятся,
-- партнёрская экономика пока выключена.
-- ============================================================

alter table public.director_bonus_settings
  add column if not exists
    revenue_cashback_enabled boolean
    not null
    default false;

alter table public.director_bonus_settings
  add column if not exists
    bonus_redemption_enabled boolean
    not null
    default false;

alter table public.director_bonus_settings
  add column if not exists
    qr_visit_bonus_enabled boolean
    not null
    default false;
