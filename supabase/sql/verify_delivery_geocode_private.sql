-- Read-only deployment assertions. No address/customer rows are read.
-- Every returned `passed` value must be true; missing objects fail the checks.
with targets(name, object_id, needs_insert) as (
  values
    ('delivery_address_locations', to_regclass('public.delivery_address_locations'), true),
    ('delivery_geocode_limiter', to_regclass('public.delivery_geocode_limiter'), false)
), table_checks as (
  select t.name,
    c.oid is not null as object_exists,
    coalesce(c.relrowsecurity, false) as rls_enabled,
    not exists (
      select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
      where acl.grantee = 0
    ) as public_has_no_table_acl,
    not coalesce(has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), true)
      and not coalesce(has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'), true) as anon_has_no_access,
    not coalesce(has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), true)
      and not coalesce(has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'), true) as authenticated_has_no_access,
    not exists (select 1 from pg_policy p where p.polrelid = c.oid) as no_browser_policies,
    coalesce(has_table_privilege('service_role', c.oid, 'SELECT'), false)
      and coalesce(has_table_privilege('service_role', c.oid, 'UPDATE'), false)
      and (not t.needs_insert or coalesce(has_table_privilege('service_role', c.oid, 'INSERT'), false)) as service_has_required_access,
    not coalesce(has_table_privilege('service_role', c.oid, 'DELETE,TRUNCATE,REFERENCES,TRIGGER'), true)
      and (t.needs_insert or not coalesce(has_table_privilege('service_role', c.oid, 'INSERT'), true)) as service_has_no_extra_table_access
  from targets t
  left join pg_class c on c.oid = t.object_id
), function_targets(name, object_id) as (
  values
    ('claim_delivery_geocode_slot', to_regprocedure('public.claim_delivery_geocode_slot(uuid)')),
    ('finish_delivery_geocode_slot', to_regprocedure('public.finish_delivery_geocode_slot(uuid,integer)'))
), function_checks as (
  select t.name,
    p.oid is not null as object_exists,
    not exists (
      select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) as public_has_no_execute,
    not coalesce(has_function_privilege('anon', p.oid, 'EXECUTE'), true) as anon_has_no_execute,
    not coalesce(has_function_privilege('authenticated', p.oid, 'EXECUTE'), true) as authenticated_has_no_execute,
    coalesce(has_function_privilege('service_role', p.oid, 'EXECUTE'), false) as service_has_execute,
    not coalesce(p.prosecdef, true) as security_invoker
  from function_targets t
  left join pg_proc p on p.oid = t.object_id
)
select 'table' as object_type, name,
  object_exists and rls_enabled and public_has_no_table_acl
    and anon_has_no_access and authenticated_has_no_access and no_browser_policies
    and service_has_required_access and service_has_no_extra_table_access as passed,
  to_jsonb(table_checks) - 'name' as checks
from table_checks
union all
select 'function', name,
  object_exists and public_has_no_execute and anon_has_no_execute
    and authenticated_has_no_execute and service_has_execute and security_invoker as passed,
  to_jsonb(function_checks) - 'name' as checks
from function_checks
order by object_type, name;
