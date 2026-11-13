-- First installation of the private delivery geocoding cache. No customer rows are changed.
-- Apply through the project's normal migration workflow after review and confirmation that
-- both target tables and both target functions are absent. Existing objects cause an error;
-- this installer never drops or replaces them.
create table public.delivery_address_locations (
  address_key text primary key check (char_length(address_key) between 1 and 300),
  address text not null check (char_length(address) between 1 and 300),
  lat double precision,
  lng double precision,
  status text not null check (status in ('resolved', 'not_found', 'ambiguous')),
  precision text check (precision in ('address', 'building')),
  source text not null default 'gugik-uug',
  updated_at timestamptz not null default now(),
  constraint delivery_address_locations_coordinates check (
    (status = 'resolved' and lat is not null and lng is not null and precision is not null and lat between -90 and 90 and lng between -180 and 180)
    or (status <> 'resolved' and lat is null and lng is null and precision is null)
  )
);

alter table public.delivery_address_locations enable row level security;
-- Revoke Supabase default grants. Browsers must never enumerate this
-- shared address/location cache.
revoke all on public.delivery_address_locations from public, anon, authenticated, service_role;
grant select, insert, update on public.delivery_address_locations to service_role;
-- No public/anon/authenticated RLS policy. The service role uses its existing
-- backend-only privileges; the Edge API returns one caller-supplied address.

-- This service-only row serializes upstream traffic across all browsers and Edge workers.
create table public.delivery_geocode_limiter (
  id text primary key check (id = 'gugik-uug'),
  next_allowed_at timestamptz not null default '-infinity',
  lease_until timestamptz not null default '-infinity',
  lease_token uuid
);
alter table public.delivery_geocode_limiter enable row level security;
revoke all on public.delivery_geocode_limiter from public, anon, authenticated, service_role;
grant select, update on public.delivery_geocode_limiter to service_role;
insert into public.delivery_geocode_limiter (id) values ('gugik-uug');

create function public.claim_delivery_geocode_slot(p_token uuid)
returns table(granted boolean, retry_after_ms integer)
language plpgsql security invoker set search_path = '' as $$
declare
  gate public.delivery_geocode_limiter%rowtype;
  observed_at timestamptz := clock_timestamp();
  blocked_until timestamptz;
begin
  if p_token is null then raise exception 'A lease token is required'; end if;
  select * into strict gate from public.delivery_geocode_limiter where id = 'gugik-uug' for update;
  blocked_until := greatest(gate.next_allowed_at, gate.lease_until);
  if blocked_until > observed_at then
    return query select false, greatest(100, ceil(extract(epoch from (blocked_until - observed_at)) * 1000)::integer);
    return;
  end if;
  update public.delivery_geocode_limiter
    set next_allowed_at = observed_at + interval '1100 milliseconds',
        lease_until = observed_at + interval '30 seconds', lease_token = p_token
    where id = 'gugik-uug';
  return query select true, 0;
end;
$$;

create function public.finish_delivery_geocode_slot(p_token uuid, p_backoff_ms integer default 0)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.delivery_geocode_limiter
    set next_allowed_at = greatest(next_allowed_at, clock_timestamp() + make_interval(secs => least(600000, greatest(0, coalesce(p_backoff_ms, 0))) / 1000.0)),
        lease_until = clock_timestamp(), lease_token = null
    where id = 'gugik-uug' and lease_token = p_token;
end;
$$;

revoke all on function public.claim_delivery_geocode_slot(uuid) from public, anon, authenticated;
revoke all on function public.finish_delivery_geocode_slot(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_delivery_geocode_slot(uuid) to service_role;
grant execute on function public.finish_delivery_geocode_slot(uuid, integer) to service_role;

comment on table public.delivery_address_locations is 'Private shared address-only geocoding cache. SELECT/INSERT/UPDATE are restricted to the Edge Function service role; no browser listing or direct table access.';
comment on table public.delivery_geocode_limiter is 'Service-only upstream request limiter. One active request and at least 1100 ms between starts; no browser writes.';
