-- Avoid the local stops variable colliding with trips.stops in UPDATE statements.
create or replace function trampo.route_action(p_trip uuid,p_uid uuid,p_action text,p_body jsonb,p_stop_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t trampo.trips; b jsonb:=coalesce(p_body,'{}'::jsonb); stop jsonb; v_stops jsonb; q jsonb; f jsonb; next_stop jsonb; old jsonb; new_place jsonb; n int;
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
    v_stops:=t.stops||jsonb_build_array(stop);
    q:=trampo.route_quote(t.pickup,v_stops,t.dropoff,t.service);
    update trampo.trips set stops=v_stops,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'stop_added',jsonb_build_object('name',stop->>'name','fare',q->>'fare'));
    return jsonb_build_object('status',201,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  elsif p_action='remove_stop' then
    select value into stop from jsonb_array_elements(t.stops) s where s.value->>'id'=p_stop_id;
    if stop is null or stop->>'status'<>'pending' then return trampo.err(409,'Only a pending stop can be removed.'); end if;
    select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into v_stops from jsonb_array_elements(t.stops) with ordinality as s(value,ord) where value->>'id'<>p_stop_id;
    q:=trampo.route_quote(t.pickup,v_stops,t.dropoff,t.service);
    update trampo.trips set stops=v_stops,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'stop_removed',jsonb_build_object('stopId',p_stop_id,'fare',q->>'fare'));
    return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  elsif p_action='destination' then
    if length(trim(coalesce(b->>'name','')))<1 or length(b->>'name')>140 or not trampo.in_uganda(b) then return trampo.err(400,'Choose a named destination inside Uganda.'); end if;
    new_place:=jsonb_build_object('lat',(b->>'lat')::float,'lng',(b->>'lng')::float,'name',left(trim(b->>'name'),140),'area',left(coalesce(b->>'area',''),240));
    q:=trampo.route_quote(t.pickup,t.stops,new_place,t.service); old:=t.dropoff;
    update trampo.trips set dropoff=new_place,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'destination_changed',jsonb_build_object('from',old,'to',new_place,'fare',q->>'fare'));
    return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  elsif p_action='arrive_stop' then
    f:=trampo.fix(p_uid);
    if f is null or not trampo.in_uganda(f) or (f->>'updatedAt')::bigint<trampo.ms()-15000 or (f->>'updatedAt')::bigint>trampo.ms()+5000 or (f->>'accuracy')::float<0 or (f->>'accuracy')::float>50 then return trampo.err(409,'Refresh your GPS before marking the stop reached.'); end if;
    select value into next_stop from jsonb_array_elements(t.stops) s where s.value->>'status'='pending' order by s.ordinality limit 1;
    if next_stop is null or next_stop->>'id'<>p_stop_id then return trampo.err(409,'Reach the next pending stop first.'); end if;
    if trampo.distance_m(f,next_stop)>50 then return trampo.err(409,'Move within 50 m of the stop before marking it reached.'); end if;
    select coalesce(jsonb_agg(case when value->>'id'=p_stop_id then value||jsonb_build_object('status','arrived','arrivedAt',trampo.ms()) else value end order by ord),'[]'::jsonb) into v_stops from jsonb_array_elements(t.stops) with ordinality as s(value,ord);
    q:=trampo.route_quote(t.pickup,v_stops,t.dropoff,t.service);
    update trampo.trips set stops=v_stops,fare=(q->>'fare')::numeric,distance_km=(q->>'distanceKm')::float,minutes=(q->>'minutes')::int where id=t.id;
    perform trampo.event(t.id,p_uid,'stop_arrived',jsonb_build_object('stopId',p_stop_id));
    return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(t.id,p_uid)));
  end if;
  return trampo.err(404,'Route action not found.');
exception when invalid_text_representation or numeric_value_out_of_range then return trampo.err(400,'Invalid route location.');
  when raise_exception then return trampo.err(400,sqlerrm);
end $$;

revoke all on function trampo.route_action(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function trampo.route_action(uuid,uuid,text,jsonb,text) to service_role;
