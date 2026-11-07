-- Durable scheduled dispatch, Night Shield transitions, missed check-in escalation,
-- ringing-call expiry, and rate-limit cleanup. Runs inside Supabase Postgres.
create extension if not exists pg_cron with schema cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'trampo-tick') then
    perform cron.unschedule('trampo-tick');
  end if;
end $$;

select cron.schedule('trampo-tick', '* * * * *', $cron$select trampo.tick()$cron$);
