-- Fix: the "too_far" GPS reason used `reasons || 'too_far'`, which Postgres
-- resolved as text[] || text[] and raised "malformed array literal". That made
-- a far-apart start attempt return 500 instead of a clean 409 GPS_NOT_MATCHED.
-- Use array_append so the scalar is unambiguously appended.
create or replace function trampo.gps_match(rider jsonb, driver jsonb, dark boolean) returns jsonb language plpgsql stable as $$
declare reasons text[] := '{}'; d float; threshold int := case when dark then 25 else 35 end; now_ms bigint := trampo.ms(); f jsonb; role_name text;
begin
  foreach role_name in array array['passenger','driver'] loop
    f := case when role_name='passenger' then rider else driver end;
    if f is null or not trampo.in_uganda(f) then reasons := array_append(reasons, role_name||'_missing');
    else
      if (f->>'updatedAt')::bigint < now_ms-15000 or (f->>'updatedAt')::bigint > now_ms+5000 then reasons := array_append(reasons, role_name||'_stale'); end if;
      if (f->>'accuracy')::float < 0 or (f->>'accuracy')::float > 50 then reasons := array_append(reasons, role_name||'_inaccurate'); end if;
    end if;
  end loop;
  d := trampo.distance_m(rider, driver);
  if d is not null and d > threshold then reasons := array_append(reasons, 'too_far'); end if;
  return jsonb_build_object('matched',cardinality(reasons)=0 and d is not null,'distance',round(d),'threshold',threshold,'reasons',to_jsonb(reasons),'maxAccuracy',50,'maxAgeSeconds',15);
end $$;
