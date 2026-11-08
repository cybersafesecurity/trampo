-- Availability-first dispatch with proximity ranking and no maximum radius.
-- A sole eligible driver 100 miles away is still a candidate. Boarding gates
-- (fresh/accurate GPS, passenger confirmation, PIN, shift and Night Shield)
-- remain unchanged. All matching is server-side and transactional.

create or replace function trampo.dispatch_candidates(pickup jsonb, svc text)
returns table(user_id uuid, distance_m double precision, rating double precision)
language sql stable security definer set search_path = '' as $$
  select d.user_id, trampo.distance_m(to_jsonb(l), pickup), d.rating
  from trampo.drivers d
  join trampo.profiles p on p.id=d.user_id
  join trampo.locations l on l.user_id=d.user_id
  where d.status='approved' and d.online and p.status='active' and p.role='driver'
    and d.vehicle_type=svc
    and d.shift_check_at is not null and d.shift_check_at between trampo.ms()-43200000 and trampo.ms()+5000
    and l.source='browser' and trampo.in_uganda(to_jsonb(l))
    and l.accuracy between 0 and 50
    and l.updated_at between trampo.ms()-30000 and trampo.ms()+5000
    and not exists (select 1 from trampo.trips t where t.driver_id=d.user_id and t.status in ('assigned','in_progress'))
    and trampo.distance_m(to_jsonb(l), pickup) is not null
  order by trampo.distance_m(to_jsonb(l), pickup), d.rating desc, d.user_id
$$;
revoke all on function trampo.dispatch_candidates(jsonb,text) from public, anon, authenticated;
grant execute on function trampo.dispatch_candidates(jsonb,text) to service_role;

create or replace function trampo.match_trip(tid uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare t trampo.trips; chosen uuid; meters double precision; candidates int; driver_name text;
begin
  -- Serialize this small pilot's matching decisions; row constraints remain the
  -- final protection against double assignment. Replace with a queue at scale.
  perform pg_advisory_xact_lock(hashtext('trampo:dispatch'));
  select * into t from trampo.trips where id=tid and status='searching' for update;
  if t.id is null then return null; end if;
  select count(*) into candidates from trampo.dispatch_candidates(t.pickup,t.service);
  select c.user_id,c.distance_m into chosen,meters from trampo.dispatch_candidates(t.pickup,t.service) c limit 1;
  if chosen is null then return null; end if;
  -- Recheck after taking the driver row lock: going offline/suspension may have
  -- happened between ranking and assignment.
  perform 1 from trampo.drivers where user_id=chosen for update;
  if not exists (select 1 from trampo.dispatch_candidates(t.pickup,t.service) c where c.user_id=chosen) then return null; end if;
  update trampo.trips set driver_id=chosen,status='assigned',assigned_at=trampo.ms(),night_mode=trampo.night(),simulated=false
    where id=tid and status='searching';
  select name into driver_name from trampo.profiles where id=chosen;
  perform trampo.event(tid,chosen,'driver_matched',jsonb_build_object('name',driver_name,'distanceMeters',round(meters),'eligibleDrivers',candidates,'policy','availability_then_proximity','maxDistance',null));
  return chosen;
end $$;
revoke all on function trampo.match_trip(uuid) from public, anon, authenticated;
grant execute on function trampo.match_trip(uuid) to service_role;

create or replace function trampo.match_waiting()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select id from trampo.trips where status='searching' order by created_at,id limit 100 loop
    perform trampo.match_trip(r.id);
  end loop;
end $$;
revoke all on function trampo.match_waiting() from public, anon, authenticated;
grant execute on function trampo.match_waiting() to service_role;

-- Patch the deployed API without rewriting unrelated auth/profile/call routes.
do $$
declare def text;
begin
  def := pg_get_functiondef('trampo.dispatch(uuid,text,text,jsonb)'::regprocedure);
  if position('trampo.distance_m(trampo.fix(p_uid),t.pickup)<=8000' in def)=0 then
    raise exception 'Expected live dispatch radius clause is absent; inspect before deploying';
  end if;
  -- Live requests are auto-matched; do not expose a radius-limited manual queue.
  def := replace(def,
    'select coalesce(jsonb_agg(trampo.trip_json(t.id,p_uid) order by t.created_at desc),''[]''::jsonb) into counts
      from trampo.trips t join trampo.drivers dd on dd.user_id=p_uid
      where t.status=''searching'' and t.scheduled_at is null and t.service=dd.vehicle_type and dd.status=''approved''
        and trampo.fix(p_uid) is not null and trampo.distance_m(trampo.fix(p_uid),t.pickup)<=8000;',
    'counts := ''[]''::jsonb;');
  def := replace(def,
    'perform trampo.event(tid,p_uid,case when b ? ''scheduledAt'' then ''ride_scheduled'' else ''ride_requested'' end,jsonb_build_object(''service'',b->>''service''));',
    'perform trampo.event(tid,p_uid,case when b ? ''scheduledAt'' then ''ride_scheduled'' else ''ride_requested'' end,jsonb_build_object(''service'',b->>''service''));
    if not (b ? ''scheduledAt'') then perform trampo.match_trip(tid); end if;');
  def := replace(def,
    'if trampo.fix(p_uid) is null or (trampo.fix(p_uid)->>''updatedAt'')::bigint<now_ms-30000 or trampo.distance_m(trampo.fix(p_uid),t.pickup)>8000 then return trampo.err(400,''This pickup is outside your 8 km dispatch radius, or your GPS needs refreshing.''); end if;
      update trampo.trips set driver_id=p_uid,status=''assigned'',assigned_at=now_ms,night_mode=trampo.night(),simulated=false where id=tid and status=''searching'' returning * into t;
      if t.id is null then return trampo.err(409,''This request is no longer available.''); end if;
      perform trampo.event(tid,p_uid,''driver_matched'',jsonb_build_object(''name'',u.name));',
    'if t.status=''assigned'' and t.driver_id=p_uid then return jsonb_build_object(''status'',200,''body'',jsonb_build_object(''trip'',trampo.trip_json(tid,p_uid))); end if;
      return trampo.err(409,''Requests are matched automatically by availability, then proximity. Keep your GPS fresh and stay online.'');');
  def := replace(def,
    'return jsonb_build_object(''status'',200,''body'',jsonb_build_object(''location'',trampo.fix(p_uid)));',
    'if u.role=''driver'' then perform trampo.match_waiting(); end if;
    return jsonb_build_object(''status'',200,''body'',jsonb_build_object(''location'',trampo.fix(p_uid)));');
  def := replace(def,
    'update trampo.drivers set online=(b->>''online'')::boolean where user_id=p_uid;',
    'perform pg_advisory_xact_lock(hashtext(''trampo:dispatch''));
    update trampo.drivers set online=(b->>''online'')::boolean where user_id=p_uid;
    if (b->>''online'')::boolean then perform trampo.match_waiting(); end if;');
  def := replace(def,
    'update trampo.drivers set shift_check_at=now_ms,shift_check_json=b where user_id=p_uid;',
    'perform pg_advisory_xact_lock(hashtext(''trampo:dispatch''));
    update trampo.drivers set shift_check_at=now_ms,shift_check_json=b where user_id=p_uid;
    perform trampo.match_waiting();');
  if position('8000' in def)>0 or position('trampo.match_trip(tid)' in def)=0 or position('#variable_conflict use_column' in def)=0 then
    raise exception 'Dispatch patch did not apply cleanly';
  end if;
  execute def;
end $$;

create or replace function trampo.tick() returns void language plpgsql security definer set search_path = '' as $$
declare t trampo.trips; now_ms bigint := trampo.ms(); aid uuid;
begin
  update trampo.trips set status='searching',created_at=now_ms where status='scheduled' and scheduled_at<=now_ms;
  perform trampo.match_waiting();
  for t in select * from trampo.trips where status in ('assigned','in_progress') loop
    if t.night_mode <> trampo.night() then
      update trampo.trips set night_mode=trampo.night(),last_checkin_at=now_ms,checkin_escalated=false where id=t.id;
      perform trampo.event(t.id,null,case when trampo.night() then 'night_shield_activated' else 'night_shield_ended' end);
    end if;
  end loop;
  for t in select * from trampo.trips where status in ('assigned','in_progress') and night_mode and not checkin_escalated loop
    if now_ms > coalesce(t.last_checkin_at,t.started_at,t.assigned_at)+420000 then
      insert into trampo.alerts(id,trip_id,user_id,kind,lat,lng,location_at,created_at)
        values(gen_random_uuid(),t.id,t.rider_id,'missed_checkin',(trampo.fix(t.rider_id)->>'lat')::float,(trampo.fix(t.rider_id)->>'lng')::float,(trampo.fix(t.rider_id)->>'updatedAt')::bigint,now_ms) returning id into aid;
      update trampo.trips set checkin_escalated=true where id=t.id;
      perform trampo.event(t.id,null,'checkin_escalated',jsonb_build_object('alertId',aid));
    end if;
  end loop;
  update trampo.calls set status='ended',ended_at=now_ms where status='ringing' and started_at<now_ms-45000;
  delete from trampo.rate_limits where window_start<now_ms-120000;
end;
$$;
revoke all on function trampo.tick() from public, anon, authenticated;
grant execute on function trampo.tick() to service_role;
