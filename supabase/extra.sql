-- Run this in Supabase SQL Editor (one time)
-- Adds "create family" function for first-time setup from the app

create or replace function public.create_family(p_name text default 'Anaqi Idris Family')
returns table (family_id uuid, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family_id uuid;
  v_invite_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.family_members where user_id = auth.uid()) then
    raise exception 'Already in a family';
  end if;

  insert into public.families (name)
  values (p_name)
  returning id, families.invite_code into v_family_id, v_invite_code;

  insert into public.family_members (family_id, user_id)
  values (v_family_id, auth.uid());

  return query select v_family_id, v_invite_code;
end;
$$;

-- Enable realtime sync (both phones see updates instantly)
alter publication supabase_realtime add table public.feedings;
