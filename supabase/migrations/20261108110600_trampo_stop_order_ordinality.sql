-- jsonb_array_elements needs WITH ORDINALITY before ordering by position.
do $patch$
declare src text; old text; new text;
begin
  select prosrc into src from pg_proc where oid='trampo.route_action(uuid,uuid,text,jsonb,text)'::regprocedure;
  old:='select value into next_stop from jsonb_array_elements(t.stops) s where s.value->>''status''=''pending'' order by s.ordinality limit 1;';
  new:='select value into next_stop from jsonb_array_elements(t.stops) with ordinality as s(value,ord) where s.value->>''status''=''pending'' order by s.ord limit 1;';
  if position(old in src)=0 then raise exception 'Expected stop ordering marker missing'; end if;
  src:=replace(src,old,new);
  execute 'create or replace function trampo.route_action(p_trip uuid,p_uid uuid,p_action text,p_body jsonb,p_stop_id text default null) returns jsonb language plpgsql security definer set search_path='''' as $f$'||src||'$f$';
end $patch$;
revoke all on function trampo.route_action(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function trampo.route_action(uuid,uuid,text,jsonb,text) to service_role;
