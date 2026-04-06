-- ═══════════════════════════════════════════════════
-- ATTENDANCE SYSTEM — Run this in your NEW Supabase project
-- ═══════════════════════════════════════════════════

-- 1. MEMBERS table
create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  password_hash text not null,       -- stored as bcrypt hash
  role text not null default 'member', -- 'admin' | 'member'
  device_fingerprint text,           -- locked after first login
  device_approved boolean default false,
  active boolean default true,
  created_at timestamptz default now()
);
alter table members enable row level security;
create policy "Allow all" on members for all using (true) with check (true);

-- 2. SESSIONS table (simple token-based auth)
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references members(id) on delete cascade,
  token text not null unique,
  device_fingerprint text,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
alter table sessions enable row level security;
create policy "Allow all" on sessions for all using (true) with check (true);

-- 3. ATTENDANCE table
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references members(id) on delete cascade,
  member_name text not null,
  date date not null,
  check_in_time timestamptz,
  check_out_time timestamptz,
  status text not null default 'present', -- 'present' | 'absent' | 'on_leave' | 'late'
  note text,
  marked_by text default 'self',          -- 'self' | 'admin'
  created_at timestamptz default now(),
  unique(member_id, date)
);
alter table attendance enable row level security;
create policy "Allow all" on attendance for all using (true) with check (true);

-- 4. Seed admin account
-- Password is: admin123 (bcrypt hash — change this after setup!)
insert into members (name, username, password_hash, role, device_approved, active)
values (
  'Admin',
  'admin',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- password: "password" — CHANGE THIS
  'admin',
  true,
  true
) on conflict (username) do nothing;
