-- Zia Clothing ERP · Supabase setup
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run. Safe to run again.

-- 1. Tables -------------------------------------------------------------------
-- All business records (products, sales, purchases, returns, expenses, contacts, stock adjustments, settings)
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (collection, id)
);

-- Who can use the app and with which role
create table if not exists public.team (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text,
  role       text not null check (role in ('admin','manager','sales','stock','viewer')),
  created_at timestamptz not null default now()
);

-- People who signed up and are waiting for the owner to grant access
create table if not exists public.requests (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  email      text,
  name       text,
  created_at timestamptz not null default now()
);

-- 2. Helper functions ---------------------------------------------------------
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.team where user_id = auth.uid()
$$;

-- Which record types each role may change. Everyone with a role may read.
create or replace function public.can_write(col text) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.my_role()
    when 'admin'   then true
    when 'manager' then true
    when 'sales'   then col in ('sales','returns','parties')
    when 'stock'   then col in ('purchases','products','adjustments','returns','parties','meta')
    else false
  end
$$;

-- The very first person to sign in becomes the admin (owner). Later sign-ins do nothing here.
create or replace function public.claim_first_admin() returns text
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return null; end if;
  if not exists (select 1 from public.team where role = 'admin') then
    insert into public.team (user_id, email, name, role)
    select u.id, u.email, coalesce(u.raw_user_meta_data->>'name', u.email), 'admin'
    from auth.users u where u.id = auth.uid()
    on conflict (user_id) do update set role = 'admin';
    delete from public.requests where user_id = auth.uid();
  end if;
  return public.my_role();
end $$;

grant execute on function public.my_role() to authenticated;
grant execute on function public.can_write(text) to authenticated;
grant execute on function public.claim_first_admin() to authenticated;

-- 3. Row level security -------------------------------------------------------
alter table public.docs     enable row level security;
alter table public.team     enable row level security;
alter table public.requests enable row level security;

drop policy if exists "docs read"   on public.docs;
drop policy if exists "docs insert" on public.docs;
drop policy if exists "docs update" on public.docs;
drop policy if exists "docs delete" on public.docs;
create policy "docs read"   on public.docs for select to authenticated using (public.my_role() is not null);
create policy "docs insert" on public.docs for insert to authenticated with check (public.can_write(collection));
create policy "docs update" on public.docs for update to authenticated using (public.can_write(collection)) with check (public.can_write(collection));
create policy "docs delete" on public.docs for delete to authenticated using (public.can_write(collection));

drop policy if exists "team read"   on public.team;
drop policy if exists "team admin"  on public.team;
create policy "team read"  on public.team for select to authenticated using (user_id = auth.uid() or public.my_role() = 'admin');
create policy "team admin" on public.team for all    to authenticated using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

drop policy if exists "requests read"   on public.requests;
drop policy if exists "requests insert" on public.requests;
drop policy if exists "requests update" on public.requests;
drop policy if exists "requests delete" on public.requests;
create policy "requests read"   on public.requests for select to authenticated using (user_id = auth.uid() or public.my_role() = 'admin');
create policy "requests insert" on public.requests for insert to authenticated with check (user_id = auth.uid());
create policy "requests update" on public.requests for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "requests delete" on public.requests for delete to authenticated using (user_id = auth.uid() or public.my_role() = 'admin');

-- 4. Live updates (every open screen refreshes when someone saves) --------------
alter table public.docs     replica identity full;
alter table public.team     replica identity full;
alter table public.requests replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.docs;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.team;     exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.requests; exception when duplicate_object then null; end;
end $$;
