-- Avoid PL/pgSQL variable/column ambiguity in the rates lookup.
create or replace function trampo.route_quote(p_pickup jsonb,p_stops jsonb,p_dropoff jsonb,p_service text)
returns jsonb language plpgsql stable set search_path='' as $$
#variable_conflict use_column
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
revoke all on function trampo.route_quote(jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function trampo.route_quote(jsonb,jsonb,jsonb,text) to service_role;
