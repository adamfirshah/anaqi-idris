create or replace function public.join_family_by_code(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_family_id uuid;
  v_existing_family_id uuid;
begin
  if v_user_id is null then
    raise exception 'You must be signed in before joining a family';
  end if;

  select f.id
  into v_family_id
  from public.families f
  where upper(trim(f.invite_code)) = upper(trim(p_invite_code))
  limit 1;

  if v_family_id is null then
    raise exception 'Invalid invite code';
  end if;

  select fm.family_id
  into v_existing_family_id
  from public.family_members fm
  where fm.user_id = v_user_id
  limit 1;

  if v_existing_family_id is not null then
    if v_existing_family_id = v_family_id then
      return v_family_id;
    end if;

    raise exception 'This account already belongs to another family';
  end if;

  insert into public.family_members (family_id, user_id)
  values (v_family_id, v_user_id);

  return v_family_id;
end;
$$;

revoke all on function public.join_family_by_code(text) from public;
grant execute on function public.join_family_by_code(text) to authenticated;
