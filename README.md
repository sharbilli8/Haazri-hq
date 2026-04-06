# Freelance HQ — Attendance System

A standalone attendance portal with device-locked check-in, admin dashboard, performance stats, and CSV exports.

---

## Setup (10 minutes)

### 1. Create a new Supabase project
- Go to https://supabase.com → New project
- Keep the URL and anon key handy

### 2. Run the SQL schema
- In your new Supabase project: SQL Editor → New query
- Paste the contents of `schema.sql` and run it
- This creates the members, sessions, and attendance tables + a default admin account

### 3. Set environment variables
- Copy `.env.example` to `.env`
- Fill in your Supabase URL and anon key:
  ```
  VITE_SUPABASE_URL=https://xxxx.supabase.co
  VITE_SUPABASE_ANON_KEY=eyJhbGci...
  ```

### 4. Install and run
```bash
npm install
npm run dev
```

### 5. Change the admin password
- The default admin is: username `admin`, password `password`
- Log in as admin → Members → ••• → Reset password
- Set a strong password immediately

### 6. Deploy to Vercel
```bash
git init
git add .
git commit -m "initial"
# Push to GitHub, then connect to Vercel
# Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel environment variables
```

---

## How it works

### Admin (you)
- Full dashboard at `/`
- See today's attendance at a glance
- Manage members — add, reset device locks, reset passwords
- Browse full attendance log with date filters
- Performance view: attendance rate per member with date range
- Export any view to CSV

### Team members
- Log in at the same URL `/`
- First login registers their device — subsequent logins from other devices are blocked
- Simple 4-option screen: Present / Late / On Leave / Absent
- Can add an optional note
- Once submitted, they cannot change it (admin can edit)

### Device lock
- When a member logs in for the first time, a browser fingerprint is computed from their device (user agent, screen, canvas, timezone, hardware)
- This fingerprint is stored against their account
- All future logins from a different device will be rejected
- Admin can reset the device lock from the Members tab if someone gets a new phone/computer

---

## Adding team members
1. Admin → Members → + Add member
2. Enter name, username, and a temporary password
3. Share the username and password with them privately
4. They log in, device gets locked to their browser

---

## CSV exports
- Attendance CSV: date, member, status, check-in time, note, marked by
- Performance CSV: member, present, late, on leave, absent, total days, attendance rate %
- Both support custom date ranges
