create or replace function trampo.ms() returns bigint language sql stable as $$ select (extract(epoch from clock_timestamp())*1000)::bigint $$;
create or replace function trampo.night() returns boolean language sql stable as $$ select extract(hour from clock_timestamp() at time zone 'Africa/Kampala') >= 19 or extract(hour from clock_timestamp() at time zone 'Africa/Kampala') < 6 $$;
create or replace function trampo.in_uganda(p jsonb) returns boolean language sql immutable as $$ select p is not null and (p->>'lat')::float between -1.55 and 4.6 and (p->>'lng')::float between 29.4 and 35.1 $$;
create or replace function trampo.distance_m(a jsonb, b jsonb) returns double precision language sql immutable as $$
  select case when a is null or b is null then null else 6371000*2*asin(sqrt(pow(sin(radians((b->>'lat')::float-(a->>'lat')::float)/2),2)+cos(radians((a->>'lat')::float))*cos(radians((b->>'lat')::float))*pow(sin(radians((b->>'lng')::float-(a->>'lng')::float)/2),2))) end $$;
create or replace function trampo.normalize_phone(v text) returns text language plpgsql immutable as $$
declare p text := regexp_replace(coalesce(v,''), '[\s()-]', '', 'g');
begin
  if p ~ '^0[37][0-9]{8}$' then return '+256'||substring(p from 2); end if;
  if p ~ '^\+256[37][0-9]{8}$' then return p; end if;
  return null;
end $$;
create or replace function trampo.quote(pickup jsonb, dropoff jsonb, svc text) returns jsonb language plpgsql immutable as $$
declare base_f int; km_f float; min_f int; rates float[]; straight float; km float; minutes int; fare int;
begin
  if not trampo.in_uganda(pickup) or not trampo.in_uganda(dropoff) then return null; end if;
  straight := trampo.distance_m(pickup, dropoff)/1000;
  if straight < 0.15 then return null; end if;
  rates := case svc when 'boda' then array[2000,900,60,3500] when 'comfort' then array[4000,1600,120,7000] when 'vip' then array[15000,2800,250,25000] else null end;
  if rates is null then return null; end if;
  km := round(straight*1.25*10)/10; minutes := ceil(km/22*60+5);
  fare := greatest(rates[4]::int, ceil((rates[1]+km*rates[2]+minutes*rates[3])/500)::int*500);
  return jsonb_build_object('distanceKm',km,'minutes',minutes,'fare',fare,'currency','UGX','estimate',true);
end $$;
create or replace function trampo.fix(uid uuid) returns jsonb language sql stable as $$
  select case when exists(select 1 from trampo.locations where user_id=uid) then (select jsonb_build_object('lat',lat,'lng',lng,'accuracy',accuracy,'source',source,'updatedAt',updated_at,'name','Current location') from trampo.locations where user_id=uid) else null end $$;
create or replace function trampo.gps_match(rider jsonb, driver jsonb, dark boolean) returns jsonb language plpgsql stable as $$
declare reasons text[] := '{}'; d float; threshold int := case when dark then 25 else 35 end; now_ms bigint := trampo.ms(); f jsonb; role_name text;
begin
  foreach role_name in array array['passenger','driver'] loop
    f := case when role_name='passenger' then rider else driver end;
    if f is null or not trampo.in_uganda(f) then reasons := reasons || (role_name||'_missing');
    else
      if (f->>'updatedAt')::bigint < now_ms-15000 or (f->>'updatedAt')::bigint > now_ms+5000 then reasons := reasons || (role_name||'_stale'); end if;
      if (f->>'accuracy')::float < 0 or (f->>'accuracy')::float > 50 then reasons := reasons || (role_name||'_inaccurate'); end if;
    end if;
  end loop;
  d := trampo.distance_m(rider, driver);
  if d is not null and d > threshold then reasons := array_append(reasons, 'too_far'); end if;
  return jsonb_build_object('matched',cardinality(reasons)=0 and d is not null,'distance',round(d),'threshold',threshold,'reasons',to_jsonb(reasons),'maxAccuracy',50,'maxAgeSeconds',15);
end $$;
create or replace function trampo.public_user(uid uuid) returns jsonb language sql stable as $$
  select case when p.id is null then null else jsonb_build_object('id',p.id,'name',p.name,'role',p.role,'accountType',p.account_type,'phone',coalesce(p.phone,''),'avatarUrl',coalesce(p.avatar_url,''),'initials',upper(left(p.name,1)||coalesce(substring(p.name from '\s(\S)'), ''))) end from trampo.profiles p where p.id=uid $$;
create or replace function trampo.driver_row(uid uuid) returns jsonb language sql stable as $$
  select to_jsonb(d) || jsonb_build_object('name',p.name,'phone',coalesce(p.phone,''),'is_demo',0,'avatar_url',p.avatar_url,'account_type',p.account_type,'online',case when d.online then 1 else 0 end) from trampo.drivers d join trampo.profiles p on p.id=d.user_id where d.user_id=uid $$;
create or replace function trampo.profile_json(uid uuid) returns jsonb language sql stable as $$
  select trampo.public_user(uid) || jsonb_build_object('email',coalesce(u.email,''),'emailVerified',u.email_confirmed_at is not null,'phoneVerified',p.phone_verified,'googleLinked',exists(select 1 from auth.identities i where i.user_id=p.id and i.provider='google'),'hasPassword',u.encrypted_password is not null,'city',p.city,'bio',p.bio,'preferredService',p.preferred_service,'accessibilityNote',p.accessibility_note,'jobTitle',p.job_title,'department',p.department,'status',p.status,'isDemo',false,'createdAt',p.created_at,'updatedAt',coalesce(p.updated_at,p.created_at),'driver',trampo.driver_row(uid))
  from trampo.profiles p join auth.users u on u.id=p.id where p.id=uid $$;
create or replace function trampo.active_trip(uid uuid) returns uuid language sql stable as $$
  select id from trampo.trips where (rider_id=uid and status in ('searching','assigned','in_progress')) or (driver_id=uid and status in ('assigned','in_progress')) order by created_at desc limit 1 $$;
create or replace function trampo.event(tid uuid, actor uuid, kind text, detail jsonb default '{}'::jsonb) returns void language sql as $$
  insert into trampo.events(trip_id,actor_id,type,detail,created_at) values(tid,actor,kind,detail,trampo.ms()) $$;
create or replace function trampo.trip_json(tid uuid, viewer uuid) returns jsonb language plpgsql stable as $$
declare t trampo.trips; d jsonb; can_see boolean; last_check bigint; out jsonb;
begin
  select * into t from trampo.trips where id=tid; if t.id is null then return null; end if;
  can_see := t.rider_id=viewer or t.driver_id=viewer or exists(select 1 from trampo.profiles where id=viewer and role='admin');
  d := case when t.driver_id is null then null else trampo.public_user(t.driver_id) || jsonb_build_object('plate',(select plate from trampo.drivers where user_id=t.driver_id),'model',(select model from trampo.drivers where user_id=t.driver_id),'color',(select color from trampo.drivers where user_id=t.driver_id),'vehicleType',t.service,'rating',(select rating from trampo.drivers where user_id=t.driver_id),'isDemo',false) end;
  last_check := coalesce(t.last_checkin_at,t.started_at,t.assigned_at);
  out := jsonb_build_object('id',t.id,'status',t.status,'service',t.service,'pickup',t.pickup,'dropoff',t.dropoff,'fare',t.fare,'finalFare',t.final_fare,'distanceKm',t.distance_km,'minutes',t.minutes,'payment',t.payment,'note',t.note,'createdAt',t.created_at,'scheduledAt',t.scheduled_at,'assignedAt',t.assigned_at,'startedAt',t.started_at,'endedAt',t.ended_at,'night',t.night_mode,'simulated',false,'rating',t.rating,'cancelReason',t.cancel_reason,'rider',trampo.public_user(t.rider_id),'driver',d);
  if can_see then
    out := out || jsonb_build_object('riderLocation',trampo.fix(t.rider_id),'driverLocation',trampo.fix(t.driver_id),'match',case when t.driver_id is null then null else trampo.gps_match(trampo.fix(t.rider_id),trampo.fix(t.driver_id),t.night_mode) end,'riderConfirmedAt',t.rider_confirmed_at,'startDistance',t.start_distance,'checkInDueAt',case when t.night_mode and t.status in ('assigned','in_progress') then last_check+300000 else null end,
      'events',coalesce((select jsonb_agg(jsonb_build_object('type',type,'detail',detail,'createdAt',created_at) order by created_at desc) from (select * from trampo.events where trip_id=tid order by created_at desc limit 30) e),'[]'::jsonb));
    if t.rider_id=viewer and t.status in ('searching','assigned') then out := out || jsonb_build_object('pin',t.pin_plain); end if;
  end if;
  return out;
end $$;
create or replace function trampo.end_calls(tid uuid) returns void language sql as $$
  update trampo.calls set status='ended',ended_at=trampo.ms() where trip_id=tid and status in ('ringing','connected');
  update trampo.shares set revoked_at=trampo.ms() where trip_id=tid and revoked_at is null;
$$;
create or replace function trampo.rate_bucket(k text, max_count int, window_ms bigint default 60000) returns boolean language plpgsql as $$
declare n int; now_ms bigint := trampo.ms();
begin
  insert into trampo.rate_limits(key,window_start,count) values(k,now_ms,1)
  on conflict (key) do update set count=case when trampo.rate_limits.window_start < now_ms-window_ms then 1 else trampo.rate_limits.count+1 end,
    window_start=case when trampo.rate_limits.window_start < now_ms-window_ms then now_ms else trampo.rate_limits.window_start end returning count into n;
  return n <= max_count;
end $$;
create or replace function trampo.err(status int, message text, code text default 'REQUEST_FAILED', details jsonb default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('status',status,'body',jsonb_build_object('error',message,'code',code,'details',details)) $$;
revoke all on all functions in schema trampo from public, anon, authenticated;
grant execute on all functions in schema trampo to service_role;
