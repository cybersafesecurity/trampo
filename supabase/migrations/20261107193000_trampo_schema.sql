-- Trampo live backend. Private schema: clients use the verified Edge Function only.
create schema if not exists trampo;
revoke all on schema trampo from public;
grant usage on schema trampo to service_role;
grant usage on schema trampo to authenticated;

create table if not exists trampo.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  phone text unique,
  role text not null default 'passenger' check (role in ('passenger','driver','admin')),
  account_type text not null default 'passenger' check (account_type in ('admin','car_driver','motorbike_rider','passenger')),
  phone_verified boolean not null default false,
  avatar_url text,
  city text not null default '',
  bio text not null default '',
  preferred_service text check (preferred_service in ('boda','comfort','vip')),
  accessibility_note text not null default '',
  job_title text not null default '',
  department text not null default '',
  status text not null default 'active' check (status in ('active','suspended')),
  created_at bigint not null,
  updated_at bigint
);
create table if not exists trampo.drivers (
  user_id uuid primary key references trampo.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  online boolean not null default false,
  vehicle_type text not null check (vehicle_type in ('boda','comfort','vip')),
  plate text not null,
  model text not null,
  color text not null,
  district text not null,
  permit_ref text not null,
  insurance_ref text not null,
  rating double precision not null default 5,
  shift_check_at bigint,
  shift_check_json jsonb,
  reviewed_at bigint,
  review_note text
);
create table if not exists trampo.locations (
  user_id uuid primary key references trampo.profiles(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision not null check (accuracy >= 0),
  source text not null default 'browser' check (source = 'browser'),
  updated_at bigint not null
);
create table if not exists trampo.trips (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references trampo.profiles(id),
  driver_id uuid references trampo.profiles(id),
  status text not null check (status in ('scheduled','searching','assigned','in_progress','completed','cancelled')),
  pickup jsonb not null,
  dropoff jsonb not null,
  service text not null check (service in ('boda','comfort','vip')),
  fare integer not null check (fare > 0),
  distance_km double precision not null,
  minutes integer not null,
  pin_hash text not null,
  pin_plain text,
  pin_attempts integer not null default 0,
  payment text not null check (payment in ('cash','mobile_money')),
  note text not null default '',
  scheduled_at bigint,
  night_mode boolean not null default false,
  simulated boolean not null default false check (simulated = false),
  created_at bigint not null,
  assigned_at bigint,
  rider_confirmed_at bigint,
  started_at bigint,
  ended_at bigint,
  start_distance double precision,
  final_fare integer,
  rating integer check (rating between 1 and 5),
  cancel_reason text,
  last_checkin_at bigint,
  checkin_escalated boolean not null default false
);
create unique index if not exists one_active_rider on trampo.trips(rider_id) where status in ('searching','assigned','in_progress');
create unique index if not exists one_active_driver on trampo.trips(driver_id) where status in ('assigned','in_progress');
create index if not exists trips_rider on trampo.trips(rider_id, created_at desc);
create index if not exists trips_driver on trampo.trips(driver_id, status);
create index if not exists trips_dispatch on trampo.trips(status, service, created_at desc);
create table if not exists trampo.events (
  id bigint generated always as identity primary key,
  trip_id uuid references trampo.trips(id) on delete cascade,
  actor_id uuid references trampo.profiles(id),
  type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at bigint not null
);
create index if not exists events_trip on trampo.events(trip_id, created_at desc);
create table if not exists trampo.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references trampo.profiles(id) on delete cascade,
  name text not null,
  phone text not null
);
create table if not exists trampo.alerts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trampo.trips(id),
  user_id uuid not null references trampo.profiles(id),
  kind text not null,
  lat double precision,
  lng double precision,
  location_at bigint,
  status text not null default 'open' check (status in ('open','resolved')),
  note text not null default '',
  created_at bigint not null,
  resolved_at bigint
);
create table if not exists trampo.shares (
  token_hash text primary key,
  trip_id uuid not null references trampo.trips(id) on delete cascade,
  expires_at bigint not null,
  revoked_at bigint
);
create table if not exists trampo.calls (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trampo.trips(id) on delete cascade,
  initiated_by uuid not null references trampo.profiles(id),
  status text not null check (status in ('ringing','connected','ended')),
  started_at bigint not null,
  answered_at bigint,
  ended_at bigint
);
create unique index if not exists one_live_call on trampo.calls(trip_id) where status in ('ringing','connected');
create table if not exists trampo.rate_limits (
  key text primary key,
  window_start bigint not null,
  count integer not null default 0
);

alter table trampo.profiles enable row level security;
alter table trampo.drivers enable row level security;
alter table trampo.locations enable row level security;
alter table trampo.trips enable row level security;
alter table trampo.events enable row level security;
alter table trampo.contacts enable row level security;
alter table trampo.alerts enable row level security;
alter table trampo.shares enable row level security;
alter table trampo.calls enable row level security;
alter table trampo.rate_limits enable row level security;
revoke all on all tables in schema trampo from anon, authenticated;
revoke all on all sequences in schema trampo from anon, authenticated;
grant all on all tables in schema trampo to service_role;
grant usage, select on all sequences in schema trampo to service_role;

create or replace function trampo.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into trampo.profiles(id, name, created_at, updated_at)
  values (new.id,
          left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(coalesce(new.email,'member'), '@', 1)), 80),
          (extract(epoch from now())*1000)::bigint,
          (extract(epoch from now())*1000)::bigint)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function trampo.handle_new_user();

-- Backfill profiles for any pre-existing auth users, never elevating roles.
insert into trampo.profiles(id, name, created_at, updated_at)
select id, left(coalesce(nullif(trim(raw_user_meta_data->>'name'), ''), split_part(coalesce(email,'member'), '@', 1)), 80),
       (extract(epoch from now())*1000)::bigint, (extract(epoch from now())*1000)::bigint
from auth.users
on conflict (id) do nothing;
