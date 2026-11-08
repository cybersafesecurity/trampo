-- Correct the empty text[] cast in the restored boarding matcher.
create or replace function trampo.gps_match(rider jsonb,driver jsonb,dark boolean default false)
returns jsonb language plpgsql stable set search_path='' as $$
declare reasons text[]:=array[]::text[]; d double precision; threshold integer:=50; max_accuracy integer:=50; max_age integer:=15; f jsonb; role text;
begin
  foreach role in array array['passenger','driver'] loop
    f:=case when role='passenger' then rider else driver end;
    if f is null or not trampo.in_uganda((f->>'lat')::float,(f->>'lng')::float) then reasons:=array_append(reasons,role||'_missing');
    else
      if (f->>'updatedAt')::bigint is null or f->>'updatedAt' !~ '^[0-9]+$' or (f->>'updatedAt')::bigint<trampo.ms()-max_age*1000 or (f->>'updatedAt')::bigint>trampo.ms()+5000 then reasons:=array_append(reasons,role||'_stale'); end if;
      if (f->>'accuracy')::float is null or (f->>'accuracy')::float<0 or (f->>'accuracy')::float>max_accuracy then reasons:=array_append(reasons,role||'_inaccurate'); end if;
    end if;
  end loop;
  if rider is not null and driver is not null then
    d:=trampo.haversine((rider->>'lat')::float,(rider->>'lng')::float,(driver->>'lat')::float,(driver->>'lng')::float);
    if d>threshold then reasons:=array_append(reasons,'too_far'); end if;
  end if;
  return jsonb_build_object('matched',cardinality(reasons)=0 and d is not null,'distance',round(d::numeric),'threshold',threshold,'reasons',to_jsonb(reasons),'maxAccuracy',max_accuracy,'maxAgeSeconds',max_age);
end $$;
revoke all on function trampo.gps_match(jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function trampo.gps_match(jsonb,jsonb,boolean) to service_role;
