-- ═══════════════════════════════════════════════════════════
-- HAAZRI HQ — Fresh start. Run in Supabase SQL Editor.
-- Drop old tables first if re-running from scratch.
-- ═══════════════════════════════════════════════════════════

-- Drop if exists (clean start)
drop table if exists attendance cascade;
drop table if exists sessions cascade;
drop table if exists settings cascade;
drop table if exists members cascade;

-- 1. MEMBERS
create table members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  password_hash text not null,
  role text not null default 'member',   -- 'superadmin' | 'admin' | 'member'
  device_fingerprint text,
  device_approved boolean default false,
  active boolean default true,
  created_at timestamptz default now()
);
alter table members enable row level security;
create policy "Allow all" on members for all using (true) with check (true);

-- 2. SESSIONS
create table sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references members(id) on delete cascade,
  token text not null unique,
  device_fingerprint text,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
alter table sessions enable row level security;
create policy "Allow all" on sessions for all using (true) with check (true);

-- 3. ATTENDANCE
create table attendance (
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
create policy "Allow all" on attendance for all using (true) with check (true);

-- 4. SETTINGS
create table settings (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);
alter table settings enable row level security;
create policy "Allow all" on settings for all using (true) with check (true);

insert into settings (key, value) values ('office_start_time', '"09:00"');

-- 5. Superadmin only
-- Username: admin   Password: admin123
-- Hash = SHA-256("admin123" + "freelancehq_salt_2024") first 32 hex chars
insert into members (name, username, password_hash, role, device_approved, active)
values (
  'Super Admin',
  'admin',
  '8c768b28489d8ff28b9d214d73ad23cb',
  'superadmin',
  true,
  true
);
