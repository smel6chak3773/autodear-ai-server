begin;

create table if not exists public.business_ownership_transfers (
  id uuid primary key default uuid_generate_v4(),

  station_id text not null
    references public.stations(id)
    on delete cascade,

  from_owner_id uuid not null
    references auth.users(id)
    on delete restrict,

  to_owner_id uuid not null
    references auth.users(id)
    on delete restrict,

  status text not null default 'pending',

  message text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  expires_at timestamptz not null
    default (now() + interval '7 days'),

  responded_at timestamptz,

  accepted_by_user_id uuid
    references auth.users(id)
    on delete set null,

  rejected_by_user_id uuid
    references auth.users(id)
    on delete set null,

  cancelled_by_user_id uuid
    references auth.users(id)
    on delete set null,

  constraint business_ownership_transfers_status_check
  check (
    status in (
      'pending',
      'accepted',
      'rejected',
      'cancelled',
      'expired'
    )
  ),

  constraint business_ownership_transfers_owner_diff_check
  check (
    from_owner_id <> to_owner_id
  )
);

create index if not exists
  business_ownership_transfers_station_idx
on public.business_ownership_transfers (
  station_id,
  created_at desc
);

create index if not exists
  business_ownership_transfers_from_owner_idx
on public.business_ownership_transfers (
  from_owner_id,
  status,
  created_at desc
);

create index if not exists
  business_ownership_transfers_to_owner_idx
on public.business_ownership_transfers (
  to_owner_id,
  status,
  created_at desc
);

create unique index if not exists
  business_ownership_transfers_pending_station_uidx
on public.business_ownership_transfers (
  station_id
)
where status = 'pending';

create index if not exists
  notifications_business_transfer_idx
on public.notifications (
  recipient_role,
  recipient_id,
  type,
  is_read,
  created_at desc
);

alter table public.business_ownership_transfers
  enable row level security;

revoke all
on table public.business_ownership_transfers
from anon, authenticated;

grant
  select,
  insert,
  update,
  delete
on table public.business_ownership_transfers
to service_role;

comment on table public.business_ownership_transfers is
  'Передача уже принадлежащей бизнес-карточки от текущего владельца другому бизнес-аккаунту. Не является claim-flow.';

comment on column public.business_ownership_transfers.station_id is
  'Существующая бизнес-карточка. При передаче station.id не меняется.';

comment on column public.business_ownership_transfers.from_owner_id is
  'Текущий владелец карточки на момент создания запроса.';

comment on column public.business_ownership_transfers.to_owner_id is
  'Новый бизнес-владелец, который должен принять передачу.';

comment on column public.business_ownership_transfers.status is
  'pending / accepted / rejected / cancelled / expired.';

commit;
