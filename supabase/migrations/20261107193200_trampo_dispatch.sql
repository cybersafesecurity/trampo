create or replace function trampo.dispatch(p_uid uuid, p_method text, p_path text, p_body jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- Row variables (u/d/t/c) share names with table aliases used in a few queries;
-- resolve any ambiguous reference to the column, not the PL/pgSQL row variable.
#variable_conflict use_column
declare
  u trampo.profiles; au auth.users; d trampo.drivers; t trampo.trips; c trampo.calls;
  b jsonb := coalesce(p_body,'{}'::jsonb); path text := split_part(p_path,'?',1); query text := coalesce(substring(p_path from '\?(.*)$'),'');
  tid uuid; target uuid; now_ms bigint := trampo.ms(); est jsonb; pin text; m jsonb; out jsonb;
  v_name text; v_phone text; v_city text; v_note text; v_reason text; v_status text; v_kind text; v_q text;
  v_vehicle jsonb; changed boolean; token text; rows jsonb; counts jsonb; n int;
begin
  if path in ('/health','/config') then
    return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true,'demo',false,'backend','supabase','office','Plot 14 Martyrs Drive, Ntinda Ministers Village, Kampala, Uganda','calling','webrtc-p2p','googleSignIn',false,'serverTime',now_ms));
  end if;
  if path ~ '^/shared/[A-Za-z0-9_-]{20,128}$' and p_method='GET' then
    select s.trip_id into tid from trampo.shares s where s.token_hash=encode(extensions.digest(convert_to(split_part(path,'/',3),'UTF8'),'sha256'),'hex') and s.revoked_at is null and s.expires_at>now_ms;
    if tid is null then return trampo.err(404,'This trip link has expired or been revoked.'); end if;
    select * into t from trampo.trips where id=tid;
    if t.status not in ('assigned','in_progress') then return trampo.err(404,'This journey has ended.'); end if;
    select jsonb_build_object('pickup',t.pickup,'dropoff',t.dropoff,'status',t.status,'driverName',split_part(p.name,' ',1),'vehicle',d.color||' '||d.model,'plate',d.plate,'location',trampo.fix(t.driver_id),'expiresAt',(select expires_at from trampo.shares where trip_id=tid and revoked_at is null order by expires_at desc limit 1)) into out
      from trampo.profiles p join trampo.drivers d on d.user_id=p.id where p.id=t.driver_id;
    return jsonb_build_object('status',200,'body',out);
  end if;
  if p_uid is null then return trampo.err(401,'Please sign in to continue.'); end if;
  select * into u from trampo.profiles where id=p_uid;
  if u.id is null then return trampo.err(401,'Profile not found. Please sign in again.'); end if;
  if u.status <> 'active' then return trampo.err(403,'This account is suspended. Contact Trampo operations.'); end if;
  select * into au from auth.users where id=p_uid;
  if p_method not in ('GET','HEAD') and not trampo.rate_bucket('api:'||p_uid,160) then return trampo.err(429,'Too many requests. Please wait a minute.'); end if;
  if path like '/demo/%' or path='/settings/night-preview' then return trampo.err(404,'Demo controls are disabled on the live backend.'); end if;
  if path='/auth/google/start' then return trampo.err(503,'Google sign-in is not configured. Use email and password.','GOOGLE_NOT_CONFIGURED'); end if;

  if path='/bootstrap' and p_method='GET' then
    select jsonb_agg(trampo.trip_json(id,p_uid) order by created_at desc) into rows from (select id,created_at from trampo.trips where rider_id=p_uid or driver_id=p_uid order by created_at desc limit 40) x;
    select coalesce(jsonb_agg(jsonb_build_object('id',d.user_id,'vehicleType',d.vehicle_type,'location',trampo.fix(d.user_id),'isDemo',false)),'[]'::jsonb) into out
      from trampo.drivers d join trampo.profiles p on p.id=d.user_id join trampo.locations l on l.user_id=d.user_id
      where d.status='approved' and d.online and p.status='active' and l.updated_at>now_ms-30000;
    select coalesce(jsonb_agg(trampo.trip_json(t.id,p_uid) order by t.created_at desc),'[]'::jsonb) into counts
      from trampo.trips t join trampo.drivers dd on dd.user_id=p_uid
      where t.status='searching' and t.scheduled_at is null and t.service=dd.vehicle_type and dd.status='approved'
        and trampo.fix(p_uid) is not null and trampo.distance_m(trampo.fix(p_uid),t.pickup)<=8000;
    select jsonb_build_object('user',trampo.public_user(p_uid),'profile',trampo.profile_json(p_uid),'googleSignIn',false,'driver',case when u.role='driver' then trampo.driver_row(p_uid) else null end,'demo',false,'night',trampo.night(),'nightPreview',false,'office','Plot 14 Martyrs Drive, Ntinda Ministers Village, Kampala, Uganda','location',trampo.fix(p_uid),'activeTrip',trampo.trip_json(trampo.active_trip(p_uid),p_uid),'trips',coalesce(rows,'[]'::jsonb),'upcoming',coalesce((select jsonb_agg(trampo.trip_json(id,p_uid)) from trampo.trips where rider_id=p_uid and status='scheduled'),'[]'::jsonb),'nearby',out,'offers',case when u.role='driver' then counts else '[]'::jsonb end,'contacts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'phone',phone)) from trampo.contacts where user_id=p_uid),'[]'::jsonb),'serverTime',now_ms) into out;
    if u.role='admin' then
      select jsonb_build_object(
        'alerts',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('userName',p.name) order by a.created_at desc) from (select * from trampo.alerts order by created_at desc limit 100) a join trampo.profiles p on p.id=a.user_id),'[]'::jsonb),
        'drivers',coalesce((select jsonb_agg(trampo.driver_row(user_id)) from trampo.drivers),'[]'::jsonb),
        'trips',coalesce((select jsonb_agg(trampo.trip_json(id,p_uid) order by created_at desc) from (select id,created_at from trampo.trips order by created_at desc limit 100) x),'[]'::jsonb),
        'stats',jsonb_build_object('drivers',(select count(*) from trampo.drivers),'approved',(select count(*) from trampo.drivers where status='approved'),'pending',(select count(*) from trampo.drivers where status='pending'),'active',(select count(*) from trampo.trips where status in ('assigned','in_progress')),'completed',(select count(*) from trampo.trips where status='completed'),'openAlerts',(select count(*) from trampo.alerts where status='open'))) into counts;
      out := out || jsonb_build_object('operations',counts);
    else out := out || jsonb_build_object('operations',null); end if;
    return jsonb_build_object('status',200,'body',out);
  end if;

  if path='/profile' then
    if p_method='GET' then return jsonb_build_object('status',200,'body',jsonb_build_object('profile',trampo.profile_json(p_uid))); end if;
    if p_method='PATCH' then
      if not trampo.rate_bucket('profile:'||p_uid,20) then return trampo.err(429,'Too many profile updates. Please wait a minute.'); end if;
      v_name := trim(b->>'name'); v_city := trim(b->>'city'); v_phone := nullif(trim(b->>'phone'),'');
      if v_name is null or char_length(v_name) not between 2 and 80 or v_city is null or char_length(v_city) not between 2 and 80 then return trampo.err(400,'Enter a valid name and city.'); end if;
      if v_phone is not null then v_phone := trampo.normalize_phone(v_phone); if v_phone is null then return trampo.err(400,'Enter a Uganda mobile number, e.g. 0772 000 101.'); end if; end if;
      if exists(select 1 from trampo.profiles where phone=v_phone and id<>p_uid) then return trampo.err(409,'Another account already uses this phone number.'); end if;
      v_vehicle := b->'vehicle';
      if v_vehicle is not null and u.role<>'driver' then return trampo.err(400,'Vehicle details belong to a driver or rider profile.'); end if;
      if coalesce(b->>'jobTitle','')<>'' or coalesce(b->>'department','')<>'' then if u.role<>'admin' then return trampo.err(400,'Staff details belong to an admin profile.'); end if; end if;
      changed := false;
      if v_vehicle is not null then
        select * into d from trampo.drivers where user_id=p_uid;
        if v_vehicle->>'vehicleType' not in ('boda','comfort','vip') or char_length(trim(v_vehicle->>'plate')) not between 4 and 16 or char_length(trim(v_vehicle->>'model')) not between 2 and 60 or char_length(trim(v_vehicle->>'color')) not between 2 and 30 or char_length(trim(v_vehicle->>'permitRef')) not between 4 and 80 or char_length(trim(v_vehicle->>'insuranceRef')) not between 4 and 80 then return trampo.err(400,'Complete all vehicle and permit fields.'); end if;
        changed := d.vehicle_type<>v_vehicle->>'vehicleType' or d.plate<>upper(trim(v_vehicle->>'plate')) or d.model<>trim(v_vehicle->>'model') or d.color<>trim(v_vehicle->>'color') or d.permit_ref<>trim(v_vehicle->>'permitRef') or d.insurance_ref<>trim(v_vehicle->>'insuranceRef');
        if changed and trampo.active_trip(p_uid) is not null then return trampo.err(409,'Finish your active trip before changing registered vehicle details.'); end if;
        update trampo.drivers set vehicle_type=v_vehicle->>'vehicleType',plate=upper(trim(v_vehicle->>'plate')),model=trim(v_vehicle->>'model'),color=trim(v_vehicle->>'color'),district=v_city,permit_ref=trim(v_vehicle->>'permitRef'),insurance_ref=trim(v_vehicle->>'insuranceRef') where user_id=p_uid;
        if changed then update trampo.drivers set status='pending',online=false,shift_check_at=null,reviewed_at=null,review_note='Vehicle or permit details changed; operations re-review required.' where user_id=p_uid; end if;
      end if;
      update trampo.profiles set name=v_name,phone=v_phone,phone_verified=case when v_phone is distinct from u.phone then false else u.phone_verified end,city=v_city,bio=left(coalesce(b->>'bio',''),240),
        preferred_service=case when u.role='passenger' and b->>'preferredService' in ('boda','comfort','vip') then b->>'preferredService' else null end,
        accessibility_note=case when u.role='passenger' then left(coalesce(b->>'accessibilityNote',''),240) else '' end,
        job_title=case when u.role='admin' then left(coalesce(b->>'jobTitle',''),80) else '' end,
        department=case when u.role='admin' then left(coalesce(b->>'department',''),80) else '' end,
        avatar_url=case when b->>'removePhoto'='true' then null else avatar_url end,
        account_type=case when u.role='driver' and v_vehicle is not null then case when v_vehicle->>'vehicleType'='boda' then 'motorbike_rider' else 'car_driver' end else account_type end,
        updated_at=now_ms where id=p_uid;
      perform trampo.event(null,p_uid,'profile_updated',jsonb_build_object('vehicleChanged',changed));
      return jsonb_build_object('status',200,'body',jsonb_build_object('profile',trampo.profile_json(p_uid),'reviewRequired',changed));
    end if;
  end if;

  if path='/admin/profiles' and p_method='GET' then
    if u.role<>'admin' then return trampo.err(403,'Operations access required.'); end if;
    v_kind := coalesce((select split_part(kv,'=',2) from unnest(string_to_array(query,'&')) kv where split_part(kv,'=',1)='kind' limit 1),'all');
    v_q := coalesce((select split_part(kv,'=',2) from unnest(string_to_array(query,'&')) kv where split_part(kv,'=',1)='q' limit 1),'');
    v_q := replace(replace(v_q,'+',' '),'%20',' ');
    if v_kind not in ('all','admin','car_driver','motorbike_rider','passenger') then return trampo.err(400,'Invalid profile type.'); end if;
    select coalesce(jsonb_agg(pr),'[]'::jsonb) into rows from (select trampo.profile_json(id) pr from trampo.profiles order by created_at desc limit 500) x
      where (v_kind='all' or pr->>'accountType'=v_kind) and (v_q='' or (coalesce(pr->>'name','')||' '||coalesce(pr->>'email','')||' '||coalesce(pr->>'phone','')||' '||coalesce(pr->>'city','')||' '||coalesce(pr->'driver'->>'plate','')) ilike '%'||v_q||'%');
    select jsonb_build_object('profiles',rows,'total',(select count(*) from trampo.profiles),'counts',jsonb_build_object('admin',(select count(*) from trampo.profiles where account_type='admin'),'car_driver',(select count(*) from trampo.profiles where account_type='car_driver'),'motorbike_rider',(select count(*) from trampo.profiles where account_type='motorbike_rider'),'passenger',(select count(*) from trampo.profiles where account_type='passenger'))) into out;
    return jsonb_build_object('status',200,'body',out);
  end if;
  if path ~ '^/admin/profiles/[0-9a-f-]{36}/status$' and p_method='POST' then
    if u.role<>'admin' then return trampo.err(403,'Operations access required.'); end if;
    target := split_part(path,'/',4)::uuid; v_status := b->>'status'; v_reason := trim(b->>'reason');
    select * into u from trampo.profiles where id=target;
    if u.id is null then return trampo.err(404,'Profile not found.'); end if;
    if u.role='admin' then return trampo.err(403,'Admin access is managed on the server, not through profile suspension.'); end if;
    if target=p_uid then return trampo.err(400,'You cannot suspend your own account.'); end if;
    if v_status not in ('active','suspended') or v_reason is null or char_length(v_reason) not between 3 and 240 then return trampo.err(400,'Choose a status and enter a reason.'); end if;
    if v_status='suspended' and trampo.active_trip(target) is not null then return trampo.err(409,'Finish this user’s active trip before suspension.'); end if;
    update trampo.profiles set status=v_status,updated_at=now_ms where id=target;
    if v_status='suspended' then update trampo.drivers set online=false where user_id=target; delete from auth.sessions where user_id=target; delete from auth.refresh_tokens where user_id=target; end if;
    perform trampo.event(null,p_uid,'account_status_changed',jsonb_build_object('targetId',target,'status',v_status,'reason',v_reason));
    return jsonb_build_object('status',200,'body',jsonb_build_object('profile',trampo.profile_json(target)));
  end if;

  if path='/location' and p_method='POST' then
    if b->>'source' is distinct from 'browser' and b ? 'source' then return trampo.err(403,'Simulated GPS is disabled on the live backend.'); end if;
    if not trampo.in_uganda(b) or (b->>'accuracy')::float is null or (b->>'accuracy')::float not between 0 and 100000 then return trampo.err(400,'Send a valid browser GPS fix inside Uganda.'); end if;
    insert into trampo.locations(user_id,lat,lng,accuracy,source,updated_at) values(p_uid,(b->>'lat')::float,(b->>'lng')::float,(b->>'accuracy')::float,'browser',now_ms)
    on conflict (user_id) do update set lat=excluded.lat,lng=excluded.lng,accuracy=excluded.accuracy,source='browser',updated_at=excluded.updated_at;
    return jsonb_build_object('status',200,'body',jsonb_build_object('location',trampo.fix(p_uid)));
  end if;
  if path='/quotes' and p_method='POST' then
    if trampo.quote(b->'pickup',b->'dropoff','boda') is null then return trampo.err(400,'Choose valid pickup and destination locations in Uganda, at least 150 m apart.'); end if;
    return jsonb_build_object('status',200,'body',jsonb_build_object('boda',trampo.quote(b->'pickup',b->'dropoff','boda'),'comfort',trampo.quote(b->'pickup',b->'dropoff','comfort'),'vip',trampo.quote(b->'pickup',b->'dropoff','vip')));
  end if;

  if path='/trips' and p_method='POST' then
    if u.role<>'passenger' then return trampo.err(403,'Use a passenger account to book a ride.'); end if;
    if au.email_confirmed_at is null then return trampo.err(403,'Confirm your email address before booking.'); end if;
    if not trampo.rate_bucket('book:'||p_uid,10) then return trampo.err(429,'Too many booking requests. Please wait a minute.'); end if;
    if b->>'service' not in ('boda','comfort','vip') or b->>'payment' not in ('cash','mobile_money') then return trampo.err(400,'Choose a valid ride type and payment method.'); end if;
    est := trampo.quote(b->'pickup',b->'dropoff',b->>'service');
    if est is null then return trampo.err(400,'Pickup and destination must be valid Uganda locations at least 150 m apart.'); end if;
    if trampo.active_trip(p_uid) is not null then return trampo.err(409,'Finish or cancel your current request first.'); end if;
    if trampo.fix(p_uid) is null or (trampo.fix(p_uid)->>'updatedAt')::bigint < now_ms-30000 or trampo.distance_m(trampo.fix(p_uid),b->'pickup')>150 then return trampo.err(409,'Use your current GPS location as pickup before booking.'); end if;
    if b ? 'scheduledAt' then
      if (b->>'scheduledAt')::bigint < now_ms+900000 or (b->>'scheduledAt')::bigint > now_ms+2592000000 then return trampo.err(400,'Schedule between 15 minutes and 30 days ahead.'); end if;
      if (select count(*) from trampo.trips where rider_id=p_uid and status='scheduled')>=3 then return trampo.err(409,'You can have up to three upcoming rides.'); end if;
    end if;
    pin := lpad((floor(random()*10000))::int::text,4,'0');
    insert into trampo.trips(id,rider_id,status,pickup,dropoff,service,fare,distance_km,minutes,pin_hash,pin_plain,payment,note,scheduled_at,night_mode,created_at)
      values(gen_random_uuid(),p_uid,case when b ? 'scheduledAt' then 'scheduled' else 'searching' end,b->'pickup',b->'dropoff',b->>'service',(est->>'fare')::int,(est->>'distanceKm')::float,(est->>'minutes')::int,extensions.crypt(pin,extensions.gen_salt('bf')),pin,b->>'payment',left(coalesce(b->>'note',''),240),nullif(b->>'scheduledAt','')::bigint,trampo.night(),now_ms) returning id into tid;
    perform trampo.event(tid,p_uid,case when b ? 'scheduledAt' then 'ride_scheduled' else 'ride_requested' end,jsonb_build_object('service',b->>'service'));
    return jsonb_build_object('status',201,'body',jsonb_build_object('trip',trampo.trip_json(tid,p_uid)));
  end if;

  if path ~ '^/trips/[0-9a-f-]{36}' then
    tid := split_part(path,'/',3)::uuid;
    select * into t from trampo.trips where id=tid;
    if t.id is null then return trampo.err(404,'Trip not found.'); end if;
    if not (t.rider_id=p_uid or t.driver_id=p_uid or u.role='admin') then return trampo.err(403,'You are not a participant in this trip.'); end if;
    if path='/trips/'||tid and p_method='GET' then return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(tid,p_uid))); end if;
    if path='/trips/'||tid||'/accept' and p_method='POST' then
      if u.role<>'driver' then return trampo.err(403,'Driver access required.'); end if;
      select * into d from trampo.drivers where user_id=p_uid;
      if d.status<>'approved' or not d.online then return trampo.err(403,'Get approved and go online first.'); end if;
      if d.vehicle_type<>t.service then return trampo.err(409,'This request needs a different vehicle class.'); end if;
      if trampo.active_trip(p_uid) is not null then return trampo.err(409,'You already have an active trip.'); end if;
      if trampo.fix(p_uid) is null or (trampo.fix(p_uid)->>'updatedAt')::bigint<now_ms-30000 or trampo.distance_m(trampo.fix(p_uid),t.pickup)>8000 then return trampo.err(400,'This pickup is outside your 8 km dispatch radius, or your GPS needs refreshing.'); end if;
      update trampo.trips set driver_id=p_uid,status='assigned',assigned_at=now_ms,night_mode=trampo.night(),simulated=false where id=tid and status='searching' returning * into t;
      if t.id is null then return trampo.err(409,'This request is no longer available.'); end if;
      perform trampo.event(tid,p_uid,'driver_matched',jsonb_build_object('name',u.name));
      return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(tid,p_uid)));
    end if;
    if path='/trips/'||tid||'/cancel' and p_method='POST' then
      if t.status not in ('searching','assigned','scheduled') then return trampo.err(409,'A started trip cannot be cancelled. Contact safety support if you need help.'); end if;
      v_reason := left(coalesce(nullif(trim(b->>'reason'),''),'Cancelled by user'),240);
      update trampo.trips set status='cancelled',ended_at=now_ms,cancel_reason=v_reason where id=tid;
      perform trampo.end_calls(tid); perform trampo.event(tid,p_uid,'ride_cancelled',jsonb_build_object('reason',v_reason));
      return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(tid,p_uid)));
    end if;
    if path='/trips/'||tid||'/confirm' and p_method='POST' then
      if p_uid<>t.rider_id or t.status<>'assigned' then return trampo.err(409,'Only the matched passenger can confirm boarding.'); end if;
      if b->>'identityChecked' is distinct from 'true' then return trampo.err(400,'Check the driver and vehicle before confirming.'); end if;
      if t.night_mode and b->>'safePickup' is distinct from 'true' then return trampo.err(400,'Confirm that you are meeting at a well-lit pickup point.'); end if;
      m := trampo.gps_match(trampo.fix(t.rider_id),trampo.fix(t.driver_id),t.night_mode);
      if not (m->>'matched')::boolean then return trampo.err(409,'Your GPS locations do not match yet. Move closer and refresh both locations.','GPS_NOT_MATCHED',m); end if;
      update trampo.trips set rider_confirmed_at=now_ms where id=tid;
      perform trampo.event(tid,p_uid,'passenger_confirmed',jsonb_build_object('distance',m->>'distance'));
      return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true,'match',m));
    end if;
    if path='/trips/'||tid||'/start' and p_method='POST' then
      if p_uid<>t.driver_id or t.status<>'assigned' then return trampo.err(409,'Only the assigned driver can start this trip.'); end if;
      if b->>'pin' !~ '^[0-9]{4}$' then return trampo.err(400,'Enter the 4-digit boarding PIN.'); end if;
      if t.pin_attempts>=5 then return trampo.err(429,'PIN attempt limit reached. Cancel and request a new ride.'); end if;
      if t.pin_hash <> extensions.crypt(b->>'pin',t.pin_hash) then
        update trampo.trips set pin_attempts=pin_attempts+1 where id=tid; perform trampo.event(tid,p_uid,'pin_rejected');
        return trampo.err(400,'That boarding PIN is not correct. Ask the passenger for their Trampo PIN.','PIN_INVALID');
      end if;
      m := trampo.gps_match(trampo.fix(t.rider_id),trampo.fix(t.driver_id),t.night_mode);
      if not (m->>'matched')::boolean then return trampo.err(409,'Trip cannot start: both phones need fresh, accurate GPS within the pickup threshold.','GPS_NOT_MATCHED',m); end if;
      if t.rider_confirmed_at is null or t.rider_confirmed_at<now_ms-120000 then return trampo.err(409,'Ask the passenger to confirm the vehicle and boarding in their app.','PASSENGER_NOT_CONFIRMED'); end if;
      select * into d from trampo.drivers where user_id=p_uid;
      if d.shift_check_at is null or d.shift_check_at<now_ms-43200000 then return trampo.err(403,'Complete your shift safety checklist first.'); end if;
      update trampo.trips set status='in_progress',started_at=now_ms,start_distance=(m->>'distance')::float,last_checkin_at=now_ms where id=tid and status='assigned';
      perform trampo.event(tid,p_uid,'trip_started',jsonb_build_object('distance',m->>'distance','threshold',m->>'threshold','pinVerified',true,'passengerConfirmed',true));
      return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(tid,p_uid),'match',m));
    end if;
    if path='/trips/'||tid||'/complete' and p_method='POST' then
      if p_uid<>t.driver_id or t.status<>'in_progress' then return trampo.err(409,'Only the driver can complete a started trip.'); end if;
      update trampo.trips set status='completed',ended_at=now_ms,final_fare=fare where id=tid;
      perform trampo.end_calls(tid); perform trampo.event(tid,p_uid,'trip_completed',jsonb_build_object('fare',t.fare,'billing','estimate'));
      return jsonb_build_object('status',200,'body',jsonb_build_object('trip',trampo.trip_json(tid,p_uid)));
    end if;
    if path='/trips/'||tid||'/rate' and p_method='POST' then
      if p_uid<>t.rider_id or t.status<>'completed' then return trampo.err(409,'Rate your completed trip.'); end if;
      if t.rating is not null then return trampo.err(409,'You have already rated this trip.'); end if;
      if (b->>'rating')::int is null or (b->>'rating')::int not between 1 and 5 then return trampo.err(400,'Choose a rating from 1 to 5.'); end if;
      update trampo.trips set rating=(b->>'rating')::int where id=tid;
      update trampo.drivers set rating=(select avg(rating) from trampo.trips where driver_id=t.driver_id and rating is not null) where user_id=t.driver_id;
      perform trampo.event(tid,p_uid,'trip_rated',jsonb_build_object('rating',b->>'rating'));
      return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
    end if;
    if path='/trips/'||tid||'/check-in' and p_method='POST' then
      if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(409,'Check-in is available during a matched journey.'); end if;
      update trampo.trips set last_checkin_at=now_ms,checkin_escalated=false where id=tid;
      perform trampo.event(tid,p_uid,'safety_checkin');
      return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true,'checkedAt',now_ms));
    end if;
    if path='/trips/'||tid||'/sos' and p_method='POST' then
      if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(409,'SOS trip alerts are available during a matched journey.'); end if;
      insert into trampo.alerts(id,trip_id,user_id,kind,lat,lng,location_at,created_at)
        values(gen_random_uuid(),tid,p_uid,'sos',(trampo.fix(p_uid)->>'lat')::float,(trampo.fix(p_uid)->>'lng')::float,(trampo.fix(p_uid)->>'updatedAt')::bigint,now_ms) returning id into target;
      perform trampo.event(tid,p_uid,'sos_raised');
      return jsonb_build_object('status',201,'body',jsonb_build_object('id',target,'recorded',true,'dispatched',false,'message','Alert saved to Trampo operations. No external emergency service has been contacted. If you are in immediate danger, call local emergency services.'));
    end if;
    if path='/trips/'||tid||'/share' then
      if p_method='POST' then
        if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(409,'Match with a driver before sharing your trip.'); end if;
        token := encode(extensions.gen_random_bytes(24),'hex');
        insert into trampo.shares(token_hash,trip_id,expires_at) values(encode(extensions.digest(convert_to(token,'UTF8'),'sha256'),'hex'),tid,now_ms+43200000);
        perform trampo.event(tid,p_uid,'share_link_created');
        return jsonb_build_object('status',201,'body',jsonb_build_object('path','#/share/'||token,'expiresAt',now_ms+43200000,'staticDemo',false));
      elsif p_method='DELETE' then
        update trampo.shares set revoked_at=now_ms where trip_id=tid and revoked_at is null;
        return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
      end if;
    end if;
    if path='/trips/'||tid||'/call' and p_method='POST' then
      if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(403,'Free calling is available only to the matched passenger and driver, until the trip ends.'); end if;
      select * into c from trampo.calls where trip_id=tid and status in ('ringing','connected') order by started_at desc limit 1;
      if c.id is not null and c.initiated_by<>p_uid and c.status='ringing' then return trampo.err(409,'The other participant is already calling. Answer the incoming call instead.'); end if;
      if c.id is null then
        insert into trampo.calls(id,trip_id,initiated_by,status,started_at) values(gen_random_uuid(),tid,p_uid,'ringing',now_ms) returning * into c;
        perform trampo.event(tid,p_uid,'call_started');
      end if;
      return jsonb_build_object('status',200,'body',jsonb_build_object('callId',c.id,'initiator',c.initiated_by,'mode','webrtc-p2p','expiresInSeconds',60));
    end if;
    if path='/trips/'||tid||'/call/config' and p_method='GET' then
      if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(403,'Calling is only available during a matched trip.'); end if;
      return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
    end if;
    if path='/trips/'||tid||'/call/answer' and p_method='POST' then
      if t.status not in ('assigned','in_progress') or not (t.rider_id=p_uid or t.driver_id=p_uid) then return trampo.err(403,'Calling is only available during a matched trip.'); end if;
      update trampo.calls set status='connected',answered_at=now_ms where trip_id=tid and status='ringing' and initiated_by<>p_uid;
      return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
    end if;
    if path='/trips/'||tid||'/call/end' and p_method='POST' then
      perform trampo.end_calls(tid);
      return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
    end if;
  end if;

  if path='/driver/register' and p_method='POST' then
    if au.email_confirmed_at is null then return trampo.err(403,'Confirm your email address before applying.'); end if;
    if u.role='admin' then return trampo.err(403,'Admin accounts cannot apply as drivers.'); end if;
    if exists(select 1 from trampo.drivers where user_id=p_uid) then return trampo.err(409,'You already have a driver application.'); end if;
    if trampo.active_trip(p_uid) is not null then return trampo.err(409,'Finish your active trip before applying.'); end if;
    v_name := trim(b->>'name'); v_phone := trampo.normalize_phone(b->>'phone'); v_city := trim(b->>'district');
    if v_name is null or char_length(v_name) not between 2 and 80 or v_phone is null or v_city is null or char_length(v_city) not between 2 and 80 then return trampo.err(400,'Enter your name, Uganda mobile number and operating district.'); end if;
    if b->>'vehicleType' not in ('boda','comfort','vip') or char_length(trim(b->>'plate')) not between 4 and 16 or char_length(trim(b->>'model')) not between 2 and 60 or char_length(trim(b->>'color')) not between 2 and 30 or char_length(trim(b->>'permitRef')) not between 4 and 80 or char_length(trim(b->>'insuranceRef')) not between 4 and 80 or b->>'consent' is distinct from 'true' then return trampo.err(400,'Complete vehicle details, references and consent.'); end if;
    if exists(select 1 from trampo.profiles where phone=v_phone and id<>p_uid) then return trampo.err(409,'This phone number is already registered.'); end if;
    insert into trampo.drivers(user_id,vehicle_type,plate,model,color,district,permit_ref,insurance_ref) values(p_uid,b->>'vehicleType',upper(trim(b->>'plate')),trim(b->>'model'),trim(b->>'color'),v_city,trim(b->>'permitRef'),trim(b->>'insuranceRef'));
    update trampo.profiles set name=v_name,phone=v_phone,phone_verified=false,city=v_city,role='driver',account_type=case when b->>'vehicleType'='boda' then 'motorbike_rider' else 'car_driver' end,updated_at=now_ms where id=p_uid;
    perform trampo.event(null,p_uid,'driver_application_submitted');
    return jsonb_build_object('status',201,'body',jsonb_build_object('user',trampo.public_user(p_uid),'status','pending','verificationRequired',false));
  end if;
  if path='/driver/online' and p_method='POST' then
    if u.role<>'driver' then return trampo.err(403,'Driver access required.'); end if;
    select * into d from trampo.drivers where user_id=p_uid;
    if d.status<>'approved' then return trampo.err(403,'Your driver application is not approved yet.'); end if;
    if (b->>'online')::boolean and (d.shift_check_at is null or d.shift_check_at<now_ms-43200000) then return trampo.err(403,'Complete the shift safety checklist before going online.'); end if;
    if not (b->>'online')::boolean and trampo.active_trip(p_uid) is not null then return trampo.err(409,'Finish your active trip before going offline.'); end if;
    update trampo.drivers set online=(b->>'online')::boolean where user_id=p_uid;
    return jsonb_build_object('status',200,'body',jsonb_build_object('online',(b->>'online')::boolean));
  end if;
  if path='/driver/checks' and p_method='POST' then
    if u.role<>'driver' then return trampo.err(403,'Driver access required.'); end if;
    if b->>'roadworthy' is distinct from 'true' or b->>'helmet' is distinct from 'true' or b->>'lights' is distinct from 'true' or b->>'identity' is distinct from 'true' then return trampo.err(400,'Complete every shift safety check.'); end if;
    update trampo.drivers set shift_check_at=now_ms,shift_check_json=b where user_id=p_uid;
    return jsonb_build_object('status',200,'body',jsonb_build_object('checkedAt',now_ms));
  end if;
  if path ~ '^/drivers/[0-9a-f-]{36}/review$' and p_method='POST' then
    if u.role<>'admin' then return trampo.err(403,'Operations access required.'); end if;
    target := split_part(path,'/',3)::uuid;
    select * into d from trampo.drivers where user_id=target;
    if d.user_id is null then return trampo.err(404,'Driver not found.'); end if;
    if d.status<>'pending' then return trampo.err(409,'This application has already been reviewed.'); end if;
    if b->>'status' not in ('approved','rejected') or char_length(trim(b->>'note')) not between 3 and 240 or b->>'documentsChecked' is distinct from 'true' then return trampo.err(400,'Record a decision, note and document check.'); end if;
    update trampo.drivers set status=b->>'status',reviewed_at=now_ms,review_note=trim(b->>'note'),online=false where user_id=target;
    perform trampo.event(null,p_uid,'driver_reviewed',jsonb_build_object('driverId',target,'status',b->>'status'));
    return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
  end if;

  if path='/contacts' and p_method='POST' then
    v_name := trim(b->>'name'); v_phone := trampo.normalize_phone(b->>'phone');
    if v_name is null or char_length(v_name) not between 2 and 80 or v_phone is null then return trampo.err(400,'Enter a contact name and Uganda mobile number.'); end if;
    if (select count(*) from trampo.contacts where user_id=p_uid)>=5 then return trampo.err(400,'Save up to five trusted contacts.'); end if;
    insert into trampo.contacts(id,user_id,name,phone) values(gen_random_uuid(),p_uid,v_name,v_phone) returning id into target;
    return jsonb_build_object('status',201,'body',jsonb_build_object('id',target,'name',v_name,'phone',v_phone));
  end if;
  if path ~ '^/contacts/[0-9a-f-]{36}$' and p_method='DELETE' then
    delete from trampo.contacts where id=split_part(path,'/',3)::uuid and user_id=p_uid;
    if not found then return trampo.err(404,'Contact not found.'); end if;
    return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
  end if;
  if path ~ '^/alerts/[0-9a-f-]{36}/resolve$' and p_method='POST' then
    if u.role<>'admin' then return trampo.err(403,'Operations access required.'); end if;
    v_note := trim(b->>'note');
    if v_note is null or char_length(v_note) not between 3 and 500 then return trampo.err(400,'Enter a resolution note.'); end if;
    update trampo.alerts set status='resolved',note=v_note,resolved_at=now_ms where id=split_part(path,'/',3)::uuid and status='open';
    if not found then return trampo.err(404,'Open alert not found.'); end if;
    return jsonb_build_object('status',200,'body',jsonb_build_object('ok',true));
  end if;
  return trampo.err(404,'Endpoint not found.');
exception when others then
  return trampo.err(500,'Something went wrong. Please try again.');
end;
$$;

create or replace function public.trampo_dispatch(p_uid uuid, p_method text, p_path text, p_body jsonb default '{}'::jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select trampo.dispatch(p_uid,p_method,p_path,p_body);
$$;
revoke all on function public.trampo_dispatch(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.trampo_dispatch(uuid,text,text,jsonb) to service_role;
revoke all on function trampo.dispatch(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function trampo.dispatch(uuid,text,text,jsonb) to service_role;

create or replace function trampo.tick() returns void language plpgsql security definer set search_path = '' as $$
declare t trampo.trips; now_ms bigint := trampo.ms(); aid uuid;
begin
  update trampo.trips set status='searching',created_at=now_ms where status='scheduled' and scheduled_at<=now_ms;
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

create or replace function trampo.can_join_channel(uid uuid, topic text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  if topic !~ '^trip:[0-9a-f-]{36}$' then return false; end if;
  tid := substring(topic from 6)::uuid;
  return exists(select 1 from trampo.trips t join trampo.profiles p on p.id=uid
    where t.id=tid and t.status in ('assigned','in_progress') and p.status='active' and (t.rider_id=uid or t.driver_id=uid));
end;
$$;
revoke all on function trampo.can_join_channel(uuid,text) from public;
grant execute on function trampo.can_join_channel(uuid,text) to authenticated, service_role;

drop policy if exists trampo_private_trip_select on realtime.messages;
drop policy if exists trampo_private_trip_insert on realtime.messages;
create policy trampo_private_trip_select on realtime.messages for select to authenticated
using (trampo.can_join_channel(auth.uid(), realtime.topic()));
create policy trampo_private_trip_insert on realtime.messages for insert to authenticated
with check (trampo.can_join_channel(auth.uid(), realtime.topic()));
