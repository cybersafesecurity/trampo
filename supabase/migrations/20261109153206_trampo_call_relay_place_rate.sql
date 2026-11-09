-- Additive live-backend support for Metered TURN credential caching and
-- fair-use address lookup. Historical migrations are intentionally untouched.

create table if not exists trampo.relay_cache (
  id text primary key,
  servers jsonb not null,
  created_at bigint not null,
  expires_at bigint not null,
  updated_at bigint not null default trampo.ms()
);
alter table trampo.relay_cache enable row level security;
revoke all on table trampo.relay_cache from public, anon, authenticated;
grant select, insert, update, delete on table trampo.relay_cache to service_role;

create or replace function trampo.relay_cache_get(p_id text)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('servers', servers, 'createdAt', created_at, 'expiresAt', expires_at)
       from trampo.relay_cache where id = p_id and expires_at > trampo.ms()),
    'null'::jsonb);
$$;

create or replace function trampo.relay_cache_set(p_id text, p_servers jsonb, p_created_at bigint, p_expires_at bigint)
returns void language plpgsql set search_path = '' as $$
begin
  if p_servers is null or jsonb_typeof(p_servers) <> 'array' or p_expires_at <= p_created_at then
    raise exception 'invalid relay cache';
  end if;
  delete from trampo.relay_cache where expires_at <= trampo.ms();
  insert into trampo.relay_cache(id, servers, created_at, expires_at, updated_at)
  values (p_id, p_servers, p_created_at, p_expires_at, trampo.ms())
  on conflict (id) do update set servers = excluded.servers, created_at = excluded.created_at,
    expires_at = excluded.expires_at, updated_at = excluded.updated_at;
end;
$$;

-- Public-schema wrapper is callable only by the Edge Function's service role.
create or replace function public.trampo_relay_cache(
  p_action text, p_id text default 'metered-turn', p_servers jsonb default null,
  p_created_at bigint default null, p_expires_at bigint default null
) returns jsonb language plpgsql set search_path = '' as $$
begin
  if p_action = 'get' then
    return trampo.relay_cache_get(p_id);
  elsif p_action = 'set' then
    if p_servers is null or p_created_at is null or p_expires_at is null then
      raise exception 'missing relay cache fields';
    end if;
    perform trampo.relay_cache_set(p_id, p_servers, p_created_at, p_expires_at);
    return '{}'::jsonb;
  end if;
  raise exception 'unknown relay cache action';
end;
$$;
revoke all on function public.trampo_relay_cache(text, text, jsonb, bigint, bigint) from public, anon, authenticated;
grant execute on function public.trampo_relay_cache(text, text, jsonb, bigint, bigint) to service_role;
revoke all on function trampo.relay_cache_get(text) from public, anon, authenticated;
revoke all on function trampo.relay_cache_set(text, jsonb, bigint, bigint) from public, anon, authenticated;
grant execute on function trampo.relay_cache_get(text) to service_role;
grant execute on function trampo.relay_cache_set(text, jsonb, bigint, bigint) to service_role;

-- Per-account and project-wide Photon limits; the provider has no autocomplete SLA.
create or replace function public.trampo_places_rate(p_uid uuid)
returns boolean language sql set search_path = '' as $$
  select trampo.rate_bucket('places:user:' || p_uid::text, 20)
     and trampo.rate_bucket('places:global', 60);
$$;
revoke all on function public.trampo_places_rate(uuid) from public, anon, authenticated;
grant execute on function public.trampo_places_rate(uuid) to service_role;
