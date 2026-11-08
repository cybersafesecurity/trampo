-- Use the live schema's jsonb helpers: in_uganda(jsonb) and distance_m(jsonb,jsonb).
create or replace function trampo.gps_match(rider jsonb,driver jsonb,dark boolean default false)
returns jsonb language plpgsql stable set search_path='' as $$
declare reasons text[]:=array[]::text[]; d double precision; threshold integer:=50; max_accuracy integer:=50; max_age integer:=15; f jsonb; role text;
begin
  foreach role in array array['passenger','driver'] loop
    f:=case when role='passenger' then rider else driver end;
    if f is null or not trampo.in_uganda(f) then reasons:=array_append(reasons,role||'_missing');
    else
      if (f->>'updatedAt')::bigint is null or f->>'updatedAt' !~ '^[0-9]+$' or (f->>'updatedAt')::bigint<trampo.ms()-max_age*1000 or (f->>'updatedAt')::bigint>trampo.ms()+5000 then reasons:=array_append(reasons,role||'_stale'); end if;
      if (f->>'accuracy')::float is null or (f->>'accuracy')::float<0 or (f->>'accuracy')::float>max_accuracy then reasons:=array_append(reasons,role||'_inaccurate'); end if;
    end if;
  end loop;
  if rider is not null and driver is not null then
    d:=trampo.distance_m(rider,driver);
    if d>threshold then reasons:=array_append(reasons,'too_far'); end if;
  end if;
  return jsonb_build_object('matched',cardinality(reasons)=0 and d is not null,'distance',round(d::numeric),'threshold',threshold,'reasons',to_jsonb(reasons),'maxAccuracy',max_accuracy,'maxAgeSeconds',max_age);
end $$;

create or replace function trampo.route_quote(p_pickup jsonb,p_stops jsonb,p_dropoff jsonb,p_service text)
returns jsonb language plpgsql stable set search_path='' as $$
declare points jsonb[]:=array[p_pickup]||coalesce((select array_agg(value order by ord) from jsonb_array_elements(coalesce(p_stops,'[]'::jsonb)) with ordinality as s(value,ord)),array[]::jsonb[])||array[p_dropoff];
  i int; straight float:=0; leg float; km float; minutes int; base_rate float; per_km float; per_min float; minimum float; fare numeric; point jsonb;
begin
  foreach point in array points loop
    if not trampo.in_uganda(point) then raise exception 'Every stop must be inside Uganda.'; end if;
  end loop;
  for i in 2..cardinality(points) loop
    leg:=trampo.distance_m(points[i-1],points[i])/1000.0;
    if leg<0.05 then raise exception 'Each new stop or destination must be at least 50 m from the previous point.'; end if;
    straight:=straight+leg;
  end loop;
  select base,per_km,per_min,minimum into base_rate,per_km,per_min,minimum from (values ('boda',2000::float,900::float,60::float,3500::float),('comfort',4000,1600,120,7000),('vip',15000,2800,250,25000)) as r(svc,base,per_km,per_min,minimum) where r.svc=p_service;
  if base_rate is null then raise exception 'Unknown service.'; end if;
  km:=round((straight*1.25)::numeric,1)::float;
  minutes:=ceil(km/22*60+5+jsonb_array_length(coalesce(p_stops,'[]'::jsonb))*3);
  fare:=greatest(minimum,ceil((base_rate+km*per_km+minutes*per_min)/500)*500);
  return jsonb_build_object('distanceKm',km,'minutes',minutes,'fare',fare,'currency','UGX','estimate',true);
end $$;

create or replace function trampo.route_action(p_trip uuid,p_uid uuid,p_action text,p_body jsonb,p_stop_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t trampo.trips; b jsonb:=coalesce(p_body,'{}'::jsonb); stop jsonb; stops jsonb; q jsonb; f jsonb; next_stop jsonb; old jsonb; new_place jsonb; n int;
begin
  if not trampo.rate_bucket('route:'||p_uid::text,30) then return trampo.err(429,'Too many route changes. Please wait a minute.'); end if;
  select * into t from trampo.trips where id=p_trip for update;
  if t.id is null then return trampo.err(404,'Trip not found.'); end if;
  if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(409,'Stops can only be changed during a matched trip.'); end if;
  if p_action in ('add_stop','remove_stop','destination') and t.rider_id<>p_uid then return trampo.err(403,'Only the passenger can change stops or the final destination.'); end if;
  if p_action='arrive_stop' and (t.driver_id<>p_uid or t.status<>'in_progress') then return trampo.err(403,'Only the driver can mark a stop reached on a started trip.'); end if;
  if p_action='add_stop' then
    select count(*) into n from jsonb_array_elements(t.stops) s where s.value->>'status'='pending';
    if n>=5 then return trampo.err(409,'You can have up to five pending stops.'); end if;
    if length(trim(coalesce(b->>'name','')))<1 or length(b->>'name')>140 or not trampo.in_uganda(b) then return trampo.err(400,'Choose a named stop inside Uganda.'); end if;
    stop:=jsonb_build_object('id',gen_random_uuid(),'name',left(trim(b->>'name'),140),'area',left(coalesce(b->>'area',''),240),'lat',(b->>'lat')::float,'lng',(b->>'lng')::float,'status','pending','addedBy',p_uid,'addedAt',trampo.ms(),'arrivedAt',null);
    stops:=t.stops||jsonb_build_array(stop);
    q:=trampo.route_quote(t.pickup,stops,t.dropoff,t.service);
    update trampo.trips set stops=stops,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,estimated_minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'stop_added',jsonb_build_object('name',stop->>'name','fare',q->>'fare'));
    return jsonb_build_object('status',201,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  elsif p_action='remove_stop' then
    select value into stop from jsonb_array_elements(t.stops) s where s.value->>'id'=p_stop_id;
    if stop is null or stop->>'status'<>'pending' then return trampo.err(409,'Only a pending stop can be removed.'); end if;
    select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into stops from jsonb_array_elements(t.stops) with ordinality as s(value,ord) where value->>'id'<>p_stop_id;
    q:=trampo.route_quote(t.pickup,stops,t.dropoff,t.service);
    update trampo.trips set stops=stops,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,estimated_minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'stop_removed',jsonb_build_object('stopId',p_stop_id,'fare',q->>'fare'));
    return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  elsif p_action='destination' then
    if length(trim(coalesce(b->>'name','')))<1 or length(b->>'name')>140 or not trampo.in_uganda(b) then return trampo.err(400,'Choose a named destination inside Uganda.'); end if;
    new_place:=jsonb_build_object('lat',(b->>'lat')::float,'lng',(b->>'lng')::float,'name',left(trim(b->>'name'),140),'area',left(coalesce(b->>'area',''),240));
    q:=trampo.route_quote(t.pickup,t.stops,new_place,t.service); old:=t.dropoff;
    update trampo.trips set dropoff=new_place,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,estimated_minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'destination_changed',jsonb_build_object('from',old,'to',new_place,'fare',q->>'fare'));
    return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  elsif p_action='arrive_stop' then
    f:=trampo.fix(p_uid);
    if f is null or not trampo.in_uganda(f) or (f->>'updatedAt')::bigint<trampo.ms()-15000 or (f->>'updatedAt')::bigint>trampo.ms()+5000 or (f->>'accuracy')::float<0 or (f->>'accuracy')::float>50 then return trampo.err(409,'Refresh your GPS before marking the stop reached.'); end if;
    select value into next_stop from jsonb_array_elements(t.stops) s where s.value->>'status'='pending' order by s.ordinality limit 1;
    if next_stop is null or next_stop->>'id'<>p_stop_id then return trampo.err(409,'Reach the next pending stop first.'); end if;
    if trampo.distance_m(f,next_stop)>50 then return trampo.err(409,'Move within 50 m of the stop before marking it reached.'); end if;
    select coalesce(jsonb_agg(case when value->>'id'=p_stop_id then value||jsonb_build_object('status','arrived','arrivedAt',trampo.ms()) else value end order by ord),'[]'::jsonb) into stops from jsonb_array_elements(t.stops) with ordinality as s(value,ord);
    q:=trampo.route_quote(t.pickup,stops,t.dropoff,t.service);
    update trampo.trips set stops=stops,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,estimated_minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'stop_arrived',jsonb_build_object('stopId',p_stop_id));
    return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  end if;
  return trampo.err(404,'Route action not found.');
exception when invalid_text_representation or numeric_value_out_of_range then return trampo.err(400,'Invalid route location.');
  when raise_exception then return trampo.err(400,sqlerrm);
end $$;

revoke all on function trampo.gps_match(jsonb,jsonb,boolean) from public,anon,authenticated;
revoke all on function trampo.route_quote(jsonb,jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function trampo.route_action(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function trampo.gps_match(jsonb,jsonb,boolean),trampo.route_quote(jsonb,jsonb,jsonb,text),trampo.route_action(uuid,uuid,text,jsonb,text) to service_role;
