-- ═══════════════════════════════════════════════════════════
-- HAAZRI HQ — Run this in your Supabase SQL Editor
-- (safe to re-run — uses IF NOT EXISTS / ON CONFLICT)
-- ═══════════════════════════════════════════════════════════

-- 1. MEMBERS
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  password_hash text not null,
  role text not null default 'member',
  device_fingerprint text,
  device_approved boolean default false,
  active boolean default true,
  created_at timestamptz default now()
);
alter table members enable row level security;
drop policy if exists "Allow all" on members;
create policy "Allow all" on members for all using (true) with check (true);

-- 2. SESSIONS
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references members(id) on delete cascade,
  token text not null unique,
  device_fingerprint text,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
alter table sessions enable row level security;
drop policy if exists "Allow all" on sessions;
create policy "Allow all" on sessions for all using (true) with check (true);

-- 3. ATTENDANCE (check_out_time added)
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references members(id) on delete cascade,
  member_name text not null,
  date date not null,
  check_in_time timestamptz,
  check_out_time timestamptz,
  status text not null default 'present',
  note text,
  marked_by text default 'self',
  created_at timestamptz default now(),
  unique(member_id, date)
);
alter table attendance enable row level security;
drop policy if exists "Allow all" on attendance;
create policy "Allow all" on attendance for all using (true) with check (true);

-- 4. SETTINGS
create table if not exists settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);
alter table settings enable row level security;
drop policy if exists "Allow all" on settings;
create policy "Allow all" on settings for all using (true) with check (true);

insert into settings (key, value) values ('office_start_time', '"09:00"') on conflict (key) do nothing;

-- 5. Seed superadmin (password: admin123 hashed with our salt)
-- IMPORTANT: Log in and change this password immediately
insert into members (name, username, password_hash, role, device_approved, active)
values (
  'Super Admin',
  'admin',
  '5e8ff9bf55ba3508199d22e984129be6',
  'superadmin',
  true,
  true
) on conflict (username) do nothing;
