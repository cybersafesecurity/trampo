-- The live trips table stores the estimate in trips.minutes.
do $patch$
declare src text;
begin
  select prosrc into src from pg_proc where oid='trampo.route_action(uuid,uuid,text,jsonb,text)'::regprocedure;
  if position('estimated_minutes=' in src)=0 then raise exception 'Expected route minutes marker missing'; end if;
  src:=replace(src,'estimated_minutes=','minutes=');
  execute 'create or replace function trampo.route_action(p_trip uuid,p_uid uuid,p_action text,p_body jsonb,p_stop_id text default null) returns jsonb language plpgsql security definer set search_path='''' as $f$'||src||'$f$';
end $patch$;
revoke all on function trampo.route_action(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function trampo.route_action(uuid,uuid,text,jsonb,text) to service_role;
