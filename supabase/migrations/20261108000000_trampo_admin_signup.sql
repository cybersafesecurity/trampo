-- Reserve the owner-controlled admin address. The password is chosen by the
-- owner in the normal signup form; admin privileges follow email verification,
-- never client-supplied role/account_type metadata.
create table if not exists trampo.admin_emails (
  email text primary key check (email = lower(trim(email)) and position('@' in email) > 1),
  created_at bigint not null default trampo.ms()
);
alter table trampo.admin_emails enable row level security;
revoke all on trampo.admin_emails from public, anon, authenticated;
grant all on trampo.admin_emails to service_role;
insert into trampo.admin_emails(email) values ('trampo.the.app@gmail.com') on conflict do nothing;

-- The previous admin was an unused provisioning placeholder with an unknown
-- password. Replace it only while it is still unused. Never delete an account
-- that has signed in, sessions, trips, audit events, calls, alerts or contacts.
do $$
declare
  old_admin auth.users;
begin
  select * into old_admin from auth.users
    where id='899610d7-2c42-4c19-b654-db20e9e18afe' and email='kampalanalf@gmail.com';
  if old_admin.id is null then return; end if;
  if exists (select 1 from auth.users where lower(email)='trampo.the.app@gmail.com') then
    raise exception 'Admin replacement stopped: the new address already has an account.';
  end if;
  if old_admin.last_sign_in_at is not null
    or exists (select 1 from trampo.profiles where id=old_admin.id and role<>'admin')
    or exists (select 1 from trampo.trips where rider_id=old_admin.id or driver_id=old_admin.id)
    or exists (select 1 from trampo.events where actor_id=old_admin.id)
    or exists (select 1 from trampo.alerts where user_id=old_admin.id)
    or exists (select 1 from trampo.contacts where user_id=old_admin.id)
    or exists (select 1 from trampo.calls where initiated_by=old_admin.id)
    or exists (select 1 from auth.sessions where user_id::text=old_admin.id::text)
    or exists (select 1 from auth.refresh_tokens where user_id::text=old_admin.id::text) then
    raise exception 'Admin replacement stopped: the old account is no longer an unused placeholder.';
  end if;
  delete from auth.users where id=old_admin.id;
end $$;

create or replace function trampo.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  approved boolean := false;
  previously_reserved boolean := false;
  changed boolean := false;
begin
  insert into trampo.profiles(id,name,created_at,updated_at)
  values (new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),split_part(coalesce(new.email,'member'),'@',1)),80),
    trampo.ms(),trampo.ms())
  on conflict (id) do nothing;

  -- This is the ONLY signup path to admin. Both the exact address and a
  -- server-recorded email confirmation are required. Google/phone identities,
  -- lookalike addresses, unconfirmed accounts and user metadata cannot grant it.
  approved := new.email_confirmed_at is not null
    and coalesce(new.raw_app_meta_data->>'provider','')='email'
    and exists (select 1 from trampo.admin_emails a where a.email=lower(new.email));

  if tg_op='UPDATE' then
    previously_reserved := exists (select 1 from trampo.admin_emails a where a.email=lower(old.email))
      and (lower(coalesce(new.email,'')) is distinct from lower(old.email) or new.email_confirmed_at is null);
  end if;

  if approved then
    update trampo.profiles set role='admin',account_type='admin',updated_at=trampo.ms()
      where id=new.id and (role<>'admin' or account_type<>'admin') returning true into changed;
    if changed then perform trampo.event(null,new.id,'admin_email_verified','{}'::jsonb); end if;
  elsif previously_reserved then
    update trampo.profiles set role='passenger',account_type='passenger',updated_at=trampo.ms()
      where id=new.id and role='admin' returning true into changed;
    if changed then perform trampo.event(null,new.id,'admin_email_revoked','{}'::jsonb); end if;
  end if;
  return new;
end $$;
revoke execute on function trampo.handle_new_user() from public, anon, authenticated;
grant execute on function trampo.handle_new_user() to service_role;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email,email_confirmed_at,raw_app_meta_data
  on auth.users for each row execute function trampo.handle_new_user();

-- Reconcile an already-verified reserved account if this migration is replayed.
-- Unconfirmed accounts stay passenger until Auth records their verification.
update auth.users set updated_at=now()
  where lower(email) in (select email from trampo.admin_emails) and email_confirmed_at is not null;
