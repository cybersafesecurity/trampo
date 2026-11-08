-- Testing mode: remove the pending GPS-match boarding gate.
-- A matched passenger/driver can confirm and start without fresh/accurate/near GPS.
-- PIN, passenger confirmation window, shift checklist and Night Shield acknowledgement
-- remain server-enforced. Dispatch eligibility still uses driver GPS for availability.
create or replace function trampo.gps_match(rider jsonb, driver jsonb, dark boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare d float;
begin
  d := trampo.distance_m(rider, driver);
  return jsonb_build_object(
    'matched', true,
    'distance', round(d),
    'threshold', null,
    'reasons', '[]'::jsonb,
    'maxAccuracy', null,
    'maxAgeSeconds', null,
    'testingBypass', true
  );
end $$;

-- Remove the now-unreachable GPS_NOT_MATCHED branches from the deployed API and
-- record that boarding used the testing bypass. Keep all other auth/PIN/shift gates.
do $$
declare def text;
begin
  def := pg_get_functiondef('trampo.dispatch(uuid,text,text,jsonb)'::regprocedure);
  def := replace(def,
    'if not (m->>''matched'')::boolean then return trampo.err(409,''Your GPS locations are not ready yet. Refresh both locations and try again.'',''GPS_NOT_MATCHED'',m); end if;',
    '-- testing mode: GPS freshness/accuracy/proximity no longer block confirmation');
  def := replace(def,
    'if not (m->>''matched'')::boolean then return trampo.err(409,''Trip cannot start: both phones need fresh, accurate GPS.'',''GPS_NOT_MATCHED'',m); end if;',
    '-- testing mode: GPS freshness/accuracy/proximity no longer block start');
  def := replace(def,
    'perform trampo.event(tid,p_uid,''passenger_confirmed'',jsonb_build_object(''distance'',m->>''distance''));',
    'perform trampo.event(tid,p_uid,''passenger_confirmed'',jsonb_build_object(''distance'',m->>''distance'',''gpsGate'',''disabled_for_testing''));');
  def := replace(def,
    'perform trampo.event(tid,p_uid,''trip_started'',jsonb_build_object(''distance'',m->>''distance'',''threshold'',m->>''threshold'',''pinVerified'',true,''passengerConfirmed'',true));',
    'perform trampo.event(tid,p_uid,''trip_started'',jsonb_build_object(''distance'',m->>''distance'',''threshold'',m->>''threshold'',''pinVerified'',true,''passengerConfirmed'',true,''gpsGate'',''disabled_for_testing''));');
  if position('GPS_NOT_MATCHED' in def)>0 then
    raise exception 'Expected live GPS_NOT_MATCHED branches were not removed cleanly';
  end if;
  execute def;
end $$;
