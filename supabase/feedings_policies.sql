alter table public.feedings enable row level security;

drop policy if exists "family_members_select_feedings_v2" on public.feedings;
create policy "family_members_select_feedings_v2"
  on public.feedings
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.family_members fm
      where fm.family_id = feedings.family_id
        and fm.user_id = (select auth.uid())
    )
  );

drop policy if exists "family_members_insert_feedings_v2" on public.feedings;
create policy "family_members_insert_feedings_v2"
  on public.feedings
  for insert
  to authenticated
  with check (
    logged_by = (select auth.uid())
    and exists (
      select 1
      from public.family_members fm
      where fm.family_id = feedings.family_id
        and fm.user_id = (select auth.uid())
    )
  );

drop policy if exists "family_members_update_feedings_v2" on public.feedings;
create policy "family_members_update_feedings_v2"
  on public.feedings
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.family_members fm
      where fm.family_id = feedings.family_id
        and fm.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.family_members fm
      where fm.family_id = feedings.family_id
        and fm.user_id = (select auth.uid())
    )
  );

drop policy if exists "family_members_delete_feedings_v2" on public.feedings;
create policy "family_members_delete_feedings_v2"
  on public.feedings
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.family_members fm
      where fm.family_id = feedings.family_id
        and fm.user_id = (select auth.uid())
    )
  );

grant select, insert, update, delete on public.feedings to authenticated;

-- Return all feeds for a family after checking the caller's membership.
-- SECURITY DEFINER avoids inconsistent table-policy visibility between sessions.
create or replace function public.get_family_feedings(p_family_id uuid)
returns setof public.feedings
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.family_members fm
    where fm.family_id = p_family_id
      and fm.user_id = auth.uid()
  ) then
    raise exception 'Not a member of this family';
  end if;

  return query
    select f.*
    from public.feedings f
    where f.family_id = p_family_id
    -- Supabase caps API results at 1,000 rows. Newest-first ensures recent
    -- feeds are never pushed outside that result window.
    order by f.logged_at desc;
end;
$$;

revoke all on function public.get_family_feedings(uuid) from public;
grant execute on function public.get_family_feedings(uuid) to authenticated;
