-- Remove the pickup distance cap (35 m day / 25 m night). Distance remains
-- informational/audited. Freshness, accuracy, Uganda bounds, rider confirmation,
-- PIN, and shift-check gates are unchanged.
create or replace function trampo.gps_match(rider jsonb, driver jsonb, dark boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  reasons text[] := '{}';
  d float;
  now_ms bigint := trampo.ms();
  f jsonb;
  role_name text;
begin
  foreach role_name in array array['passenger','driver'] loop
    f := case when role_name='passenger' then rider else driver end;
    if f is null or not trampo.in_uganda(f) then
      reasons := array_append(reasons, role_name||'_missing');
    else
      if (f->>'updatedAt')::bigint < now_ms-15000 or (f->>'updatedAt')::bigint > now_ms+5000 then
        reasons := array_append(reasons, role_name||'_stale');
      end if;
      if (f->>'accuracy')::float < 0 or (f->>'accuracy')::float > 50 then
        reasons := array_append(reasons, role_name||'_inaccurate');
      end if;
    end if;
  end loop;
  d := trampo.distance_m(rider, driver);
  return jsonb_build_object(
    'matched', cardinality(reasons)=0 and d is not null,
    'distance', round(d),
    'threshold', null,
    'reasons', to_jsonb(reasons),
    'maxAccuracy', 50,
    'maxAgeSeconds', 15
  );
end $$;

-- Keep the deployed dispatch messages aligned with the removed distance cap.
-- This patches only the two user-facing strings; all gates remain in place.
do $$
declare def text;
begin
  def := pg_get_functiondef('trampo.dispatch(uuid,text,text,jsonb)'::regprocedure);
  def := replace(def,
    'Your GPS locations do not match yet. Move closer and refresh both locations.',
    'Your GPS locations are not ready yet. Refresh both locations and try again.');
  def := replace(def,
    'Trip cannot start: both phones need fresh, accurate GPS within the pickup threshold.',
    'Trip cannot start: both phones need fresh, accurate GPS.');
  execute def;
end $$;
