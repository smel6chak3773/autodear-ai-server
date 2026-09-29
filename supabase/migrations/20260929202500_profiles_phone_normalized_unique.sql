begin;


/*
 * PROFILES_PHONE_NORMALIZED_UNIQUE_V1
 *
 * phone сохраняем в удобном пользовательском формате,
 * например:
 *
 *   +7 (978) 123-45-67
 *
 * phone_normalized используется только как технический
 * уникальный ключ:
 *
 *   +79781234567
 */


create or replace function
public.autodear_normalize_ru_phone(
  value text
)
returns text
language plpgsql
immutable
as $$
declare
  digits text;
begin
  digits :=
    regexp_replace(
      coalesce(value, ''),
      '[^0-9]',
      '',
      'g'
    );

  if digits = '' then
    return null;
  end if;

  /*
   * 8XXXXXXXXXX -> 7XXXXXXXXXX
   */
  if
    length(digits) = 11
    and left(digits, 1) = '8'
  then
    digits :=
      '7' || substr(digits, 2);

  /*
   * XXXXXXXXXX -> 7XXXXXXXXXX
   */
  elsif
    length(digits) = 10
  then
    digits :=
      '7' || digits;
  end if;

  /*
   * Для текущей российской регистрации AUTODEAR
   * принимаем только 11 цифр с кодом страны 7.
   */
  if
    length(digits) = 11
    and left(digits, 1) = '7'
  then
    return '+' || digits;
  end if;

  return null;
end;
$$;


alter table public.profiles
  add column if not exists
  phone_normalized text;


/*
 * Backfill существующих профилей.
 */
update public.profiles
set
  phone_normalized =
    public.autodear_normalize_ru_phone(
      phone
    )
where
  phone_normalized is distinct from
    public.autodear_normalize_ru_phone(
      phone
    );


/*
 * Перед созданием UNIQUE ещё раз проверяем,
 * что исторических дублей не осталось.
 */
do $$
declare
  duplicate_phone text;
begin
  select
    phone_normalized
  into
    duplicate_phone
  from
    public.profiles
  where
    phone_normalized is not null
  group by
    phone_normalized
  having
    count(*) > 1
  limit 1;

  if duplicate_phone is not null then
    raise exception
      'Duplicate normalized phone exists: %',
      duplicate_phone;
  end if;
end;
$$;


create or replace function
public.autodear_profiles_set_phone_normalized()
returns trigger
language plpgsql
as $$
begin
  new.phone_normalized :=
    public.autodear_normalize_ru_phone(
      new.phone
    );

  return new;
end;
$$;


drop trigger if exists
profiles_phone_normalized_trigger
on public.profiles;


create trigger
profiles_phone_normalized_trigger
before insert or update of phone
on public.profiles
for each row
execute function
public.autodear_profiles_set_phone_normalized();


create unique index if not exists
profiles_phone_normalized_unique_idx
on public.profiles (
  phone_normalized
)
where
  phone_normalized is not null;


comment on column
public.profiles.phone_normalized
is
  'Canonical Russian phone (+7XXXXXXXXXX). Technical unique identity key; maintained automatically from profiles.phone.';


commit;
