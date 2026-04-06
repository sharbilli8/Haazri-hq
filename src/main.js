import './style.css'
import { supabase } from './supabase.js'
import { getDeviceFingerprint, hashPassword } from './fingerprint.js'

// ─── State ────────────────────────────────────────────────────
let currentUser = null   // { id, name, username, role, device_fingerprint, device_approved }
let currentToken = null
let deviceFP = null
let adminView = 'dashboard'   // current admin view

// ─── Boot ─────────────────────────────────────────────────────
async function boot() {
  deviceFP = await getDeviceFingerprint()
  const savedToken = localStorage.getItem('att_token')
  if (savedToken) {
    const ok = await resumeSession(savedToken)
    if (ok) return
  }
  renderLogin()
}

async function resumeSession(token) {
  const { data } = await supabase
    .from('sessions')
    .select('*, members(*)')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .single()
  if (!data || !data.members) return false
  // Check device matches
  if (data.device_fingerprint && data.device_fingerprint !== deviceFP) {
    localStorage.removeItem('att_token')
    return false
  }
  currentUser  = data.members
  currentToken = token
  if (currentUser.role === 'admin') renderAdmin()
  else renderMemberCheckin()
  return true
}

// ─── Helpers ──────────────────────────────────────────────────
const todayStr     = () => new Date().toISOString().slice(0, 10)
const nowStr       = () => new Date().toISOString()
const initials     = n => n.trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
const fmt12        = ts => ts ? new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDate      = d  => d  ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—'
const fmtShortDate = d  => d  ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—'

function toast(msg, type = 'default') {
  let t = document.getElementById('toast')
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t) }
  t.textContent = msg; t.style.borderColor = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green-border)' : 'var(--border2)'
  t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800)
}

function rand(len = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len))).map(b => b.toString(16).padStart(2,'0')).join('')
}

function liveClock() {
  const el = document.getElementById('liveClock')
  const de = document.getElementById('liveDate')
  if (!el) return
  const now = new Date()
  el.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (de) de.textContent = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

function statusBadge(s) {
  const map = { present: '✅ Present', absent: '❌ Absent', late: '🕐 Late', on_leave: '🏖 On Leave' }
  return `<span class="badge badge-${s}">${map[s] || s}</span>`
}

// ─── LOGIN ────────────────────────────────────────────────────
function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <div class="login-logo">
          <div class="login-logo-icon">🕐</div>
          <div>
            <div class="login-logo-text">Freelance HQ</div>
            <div class="login-logo-sub">attendance</div>
          </div>
        </div>
        <div class="login-title">Sign in</div>
        <div class="login-sub">Enter your username and password to continue.</div>
        <div id="loginError" class="error-msg">Invalid username or password.</div>
        <div class="field-group">
          <label class="field-label">Username</label>
          <input type="text" id="loginUser" placeholder="e.g. hamza" autocomplete="username" />
        </div>
        <div class="field-group">
          <label class="field-label">Password</label>
          <input type="password" id="loginPass" placeholder="••••••••" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()" />
        </div>
        <button class="btn btn-primary" id="loginBtn" onclick="doLogin()">Sign in</button>
        <div style="margin-top:18px;font-size:12px;color:var(--text3);text-align:center;line-height:1.6;">
          First-time sign-in registers this device.<br>After that, only this device can log into your account.
        </div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `
}

window.doLogin = async function() {
  const username = document.getElementById('loginUser').value.trim().toLowerCase()
  const password = document.getElementById('loginPass').value
  const errEl    = document.getElementById('loginError')
  const btn      = document.getElementById('loginBtn')
  if (!username || !password) { errEl.textContent = 'Please enter username and password.'; errEl.classList.add('show'); return }
  btn.disabled = true; btn.textContent = 'Signing in…'
  errEl.classList.remove('show')

  const pwHash = await hashPassword(password)
  const { data: member, error } = await supabase
    .from('members')
    .select('*')
    .eq('username', username)
    .eq('password_hash', pwHash)
    .eq('active', true)
    .single()

  if (error || !member) {
    errEl.textContent = 'Invalid username or password.'; errEl.classList.add('show')
    btn.disabled = false; btn.textContent = 'Sign in'; return
  }

  // Device fingerprint logic
  if (member.device_fingerprint) {
    // Device already registered — must match
    if (member.device_fingerprint !== deviceFP) {
      errEl.textContent = '🔒 This account is locked to a different device. Contact your admin.'
      errEl.classList.add('show'); btn.disabled = false; btn.textContent = 'Sign in'; return
    }
  } else {
    // First login — register this device
    await supabase.from('members').update({ device_fingerprint: deviceFP, device_approved: true }).eq('id', member.id)
    member.device_fingerprint = deviceFP
    member.device_approved    = true
  }

  // Create session
  const token   = rand()
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await supabase.from('sessions').insert({ member_id: member.id, token, device_fingerprint: deviceFP, expires_at: expires })
  localStorage.setItem('att_token', token)
  currentUser  = member
  currentToken = token

  if (member.role === 'admin') renderAdmin()
  else renderMemberCheckin()
}

window.doLogout = async function() {
  if (currentToken) await supabase.from('sessions').delete().eq('token', currentToken)
  localStorage.removeItem('att_token')
  currentUser = null; currentToken = null
  renderLogin()
}

// ─── MEMBER CHECK-IN VIEW ─────────────────────────────────────
async function renderMemberCheckin() {
  const today = todayStr()
  const { data: existing } = await supabase
    .from('attendance')
    .select('*')
    .eq('member_id', currentUser.id)
    .eq('date', today)
    .single()

  document.getElementById('app').innerHTML = `
    <div class="checkin-wrap">
      <div class="checkin-card">
        <div class="checkin-header">
          <div class="checkin-avatar">${initials(currentUser.name)}</div>
          <div class="checkin-name">${currentUser.name}</div>
          <div class="checkin-date" id="liveDate"></div>
          <div class="today-clock" id="liveClock" style="margin-top:10px;"></div>
        </div>

        <div id="checkinContent"></div>

        <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:16px;" onclick="doLogout()">Sign out</button>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `

  setInterval(liveClock, 1000); liveClock()
  renderCheckinContent(existing)
}

function renderCheckinContent(existing) {
  const el = document.getElementById('checkinContent')
  if (!el) return

  if (existing) {
    // Already marked today
    el.innerHTML = `
      <div class="already-checkedin">
        <div class="big">✅</div>
        <div class="time">${existing.status === 'on_leave' ? '🏖 On Leave' : existing.status === 'absent' ? '❌ Absent' : fmt12(existing.check_in_time)}</div>
        <div class="label">${existing.status === 'present' || existing.status === 'late' ? 'Checked in today' : 'Status recorded'}</div>
        ${existing.note ? `<div style="margin-top:8px;font-size:12px;color:var(--text2);">"${existing.note}"</div>` : ''}
      </div>
      <div style="font-size:12px;color:var(--text3);text-align:center;padding:8px 0;">
        Today's attendance has been recorded. Contact your admin if there's an error.
      </div>
    `
  } else {
    el.innerHTML = `
      <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:10px;">Select your status for today</div>
      <div class="status-grid">
        <div class="status-option" id="opt-present" onclick="selectStatus('present')">
          <div class="status-icon">✅</div>
          <div class="status-label">Present</div>
        </div>
        <div class="status-option" id="opt-late" onclick="selectStatus('late')">
          <div class="status-icon">🕐</div>
          <div class="status-label">Late</div>
        </div>
        <div class="status-option" id="opt-on_leave" onclick="selectStatus('on_leave')">
          <div class="status-icon">🏖</div>
          <div class="status-label">On Leave</div>
        </div>
        <div class="status-option" id="opt-absent" onclick="selectStatus('absent')">
          <div class="status-icon">❌</div>
          <div class="status-label">Absent</div>
        </div>
      </div>
      <div class="field-group" style="margin-bottom:14px;">
        <label class="field-label">Note (optional)</label>
        <textarea id="checkinNote" placeholder="e.g. Doctor's appointment, working from home…" style="min-height:60px;"></textarea>
      </div>
      <button class="btn btn-primary" id="checkinSubmitBtn" onclick="submitCheckin()" disabled>Mark Attendance</button>
    `
  }
}

let selectedStatus = null
window.selectStatus = function(s) {
  selectedStatus = s
  const colorMap = { present: 'selected-green', late: 'selected-amber', on_leave: 'selected-orange', absent: 'selected-red' }
  ;['present','late','on_leave','absent'].forEach(k => {
    const el = document.getElementById('opt-' + k)
    if (el) el.className = 'status-option' + (k === s ? ' ' + colorMap[k] : '')
  })
  const btn = document.getElementById('checkinSubmitBtn')
  if (btn) btn.disabled = false
}

window.submitCheckin = async function() {
  if (!selectedStatus) return
  const btn  = document.getElementById('checkinSubmitBtn')
  const note = document.getElementById('checkinNote')?.value?.trim() || null
  btn.disabled = true; btn.textContent = 'Saving…'

  const row = {
    member_id:    currentUser.id,
    member_name:  currentUser.name,
    date:         todayStr(),
    check_in_time: ['present','late'].includes(selectedStatus) ? nowStr() : null,
    status:       selectedStatus,
    note,
    marked_by:    'self',
  }
  const { error } = await supabase.from('attendance').insert(row)
  if (error) { toast('Error saving attendance', 'error'); btn.disabled = false; btn.textContent = 'Mark Attendance'; return }
  toast('Attendance recorded ✓', 'success')
  await renderMemberCheckin()
}

// ─── ADMIN SHELL ──────────────────────────────────────────────
function renderAdmin() {
  document.getElementById('app').innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-logo">
          <div class="sidebar-logo-row">
            <div class="sidebar-logo-icon">🕐</div>
            <div>
              <div class="sidebar-logo-title">Freelance HQ</div>
              <div class="sidebar-logo-sub">attendance</div>
            </div>
          </div>
        </div>
        <div class="nav-section">Admin</div>
        <div class="nav-item active" data-view="dashboard" onclick="switchView('dashboard')">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
          Dashboard
        </div>
        <div class="nav-item" data-view="attendance" onclick="switchView('attendance')">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v4M11 1v4M2 7h12"/></svg>
          Attendance
        </div>
        <div class="nav-item" data-view="performance" onclick="switchView('performance')">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12 L5 8 L8 10 L11 5 L14 7"/></svg>
          Performance
        </div>
        <div class="nav-item" data-view="members" onclick="switchView('members')">
          <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5" r="3"/><path d="M1 14c0-3 2.5-4.5 5-4.5s5 1.5 5 4.5"/><path d="M11 7c2 0 4 1 4 4"/><circle cx="12" cy="4" r="2"/></svg>
          Members
        </div>
        <div class="sidebar-user">
          <div class="user-name">${currentUser.name}</div>
          <div class="user-role">admin</div>
          <button class="logout-btn" onclick="doLogout()">Sign out</button>
        </div>
      </aside>
      <main class="main">
        <div class="view active" id="view-dashboard"></div>
        <div class="view" id="view-attendance"></div>
        <div class="view" id="view-performance"></div>
        <div class="view" id="view-members"></div>
      </main>
    </div>

    <!-- ADD MEMBER MODAL -->
    <div class="modal-overlay" id="addMemberModal" style="display:none;">
      <div class="modal">
        <div class="modal-title">Add team member</div>
        <div class="two-col">
          <div class="field-group-m"><label class="field-label">Full name</label><input type="text" id="am-name" placeholder="e.g. Hamza Khan" /></div>
          <div class="field-group-m"><label class="field-label">Username</label><input type="text" id="am-username" placeholder="e.g. hamza" /></div>
          <div class="field-group-m"><label class="field-label">Password</label><input type="password" id="am-pass" placeholder="min 6 characters" /></div>
          <div class="field-group-m"><label class="field-label">Role</label>
            <select id="am-role"><option value="member">Member</option><option value="admin">Admin</option></select>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeAddMember()">Cancel</button>
          <button class="btn btn-primary" onclick="saveAddMember()">Add member</button>
        </div>
      </div>
    </div>

    <!-- EDIT ATTENDANCE MODAL -->
    <div class="modal-overlay" id="editAttModal" style="display:none;">
      <div class="modal">
        <div class="modal-title">Edit attendance record</div>
        <input type="hidden" id="ea-id" />
        <div class="two-col">
          <div class="field-group-m full"><label class="field-label">Member</label><input type="text" id="ea-member" disabled /></div>
          <div class="field-group-m"><label class="field-label">Date</label><input type="date" id="ea-date" /></div>
          <div class="field-group-m"><label class="field-label">Status</label>
            <select id="ea-status">
              <option value="present">✅ Present</option>
              <option value="late">🕐 Late</option>
              <option value="on_leave">🏖 On Leave</option>
              <option value="absent">❌ Absent</option>
            </select>
          </div>
          <div class="field-group-m"><label class="field-label">Check-in time</label><input type="time" id="ea-checkin" /></div>
          <div class="field-group-m full"><label class="field-label">Note</label><textarea id="ea-note" style="min-height:60px;"></textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeEditAtt()">Cancel</button>
          <button class="btn btn-primary" onclick="saveEditAtt()">Save</button>
        </div>
      </div>
    </div>

    <!-- MANUAL ATTENDANCE MODAL -->
    <div class="modal-overlay" id="manualAttModal" style="display:none;">
      <div class="modal">
        <div class="modal-title">Mark attendance manually</div>
        <div class="two-col">
          <div class="field-group-m"><label class="field-label">Member</label>
            <select id="ma-member"></select>
          </div>
          <div class="field-group-m"><label class="field-label">Date</label><input type="date" id="ma-date" /></div>
          <div class="field-group-m"><label class="field-label">Status</label>
            <select id="ma-status">
              <option value="present">✅ Present</option>
              <option value="late">🕐 Late</option>
              <option value="on_leave">🏖 On Leave</option>
              <option value="absent">❌ Absent</option>
            </select>
          </div>
          <div class="field-group-m"><label class="field-label">Check-in time (optional)</label><input type="time" id="ma-checkin" /></div>
          <div class="field-group-m full"><label class="field-label">Note</label><textarea id="ma-note" style="min-height:50px;"></textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeManualAtt()">Cancel</button>
          <button class="btn btn-primary" onclick="saveManualAtt()">Mark attendance</button>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>
  `
  switchView('dashboard')
}

window.switchView = function(v) {
  adminView = v
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'))
  document.getElementById('view-' + v)?.classList.add('active')
  document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === v))
  if (v === 'dashboard')   renderDashboard()
  if (v === 'attendance')  renderAttendanceView()
  if (v === 'performance') renderPerformanceView()
  if (v === 'members')     renderMembersView()
}

window.toggleMenu = function(e, id) {
  e.stopPropagation()
  document.querySelectorAll('.action-menu.open').forEach(m => { if (m.id !== id) m.classList.remove('open') })
  document.getElementById(id)?.classList.toggle('open')
}
document.addEventListener('click', () => document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open')))

// ─── DASHBOARD ────────────────────────────────────────────────
async function renderDashboard() {
  const el = document.getElementById('view-dashboard')
  el.innerHTML = `<div class="page-header"><div><div class="page-title">Dashboard</div><div class="page-sub">Today's snapshot · ${new Date().toLocaleDateString('en-GB', { weekday:'long', day:'2-digit', month:'long', year:'numeric' })}</div></div><button class="btn btn-ghost btn-sm" onclick="openManualAtt()">+ Mark manually</button></div><div id="dashContent"><div class="loading"><div class="spinner"></div> Loading…</div></div>`

  const today   = todayStr()
  const [membRes, attRes] = await Promise.all([
    supabase.from('members').select('*').eq('active', true).neq('role', 'admin'),
    supabase.from('attendance').select('*').eq('date', today)
  ])
  const members    = membRes.data || []
  const todayAtt   = attRes.data  || []
  const present    = todayAtt.filter(a => a.status === 'present').length
  const late       = todayAtt.filter(a => a.status === 'late').length
  const onLeave    = todayAtt.filter(a => a.status === 'on_leave').length
  const absent     = todayAtt.filter(a => a.status === 'absent').length
  const notMarked  = members.filter(m => !todayAtt.find(a => a.member_id === m.id)).length

  document.getElementById('dashContent').innerHTML = `
    <div class="stat-grid">
      <div class="stat-box sb-green"><div class="stat-label">Present</div><div class="stat-value" style="color:var(--green)">${present}</div></div>
      <div class="stat-box sb-amber"><div class="stat-label">Late</div><div class="stat-value" style="color:var(--amber)">${late}</div></div>
      <div class="stat-box sb-blue"><div class="stat-label">On Leave</div><div class="stat-value" style="color:var(--blue)">${onLeave}</div></div>
      <div class="stat-box sb-red"><div class="stat-label">Absent</div><div class="stat-value" style="color:var(--red)">${absent}</div></div>
      <div class="stat-box sb-purple"><div class="stat-label">Not marked</div><div class="stat-value" style="color:var(--accent)">${notMarked}</div></div>
      <div class="stat-box"><div class="stat-label">Total members</div><div class="stat-value">${members.length}</div></div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">Today — ${today}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Member</th><th>Status</th><th>Check-in</th><th>Note</th><th>Marked by</th></tr></thead>
        <tbody>
          ${members.map(m => {
            const a = todayAtt.find(x => x.member_id === m.id)
            return `<tr>
              <td><div style="display:flex;align-items:center;gap:9px;"><div style="width:28px;height:28px;border-radius:50%;background:var(--purple-bg);color:#a090f8;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:1px solid var(--purple-border);flex-shrink:0;">${initials(m.name)}</div>${m.name}</div></td>
              <td>${a ? statusBadge(a.status) : '<span style="color:var(--text3);font-size:12px;">Not marked</span>'}</td>
              <td style="font-family:var(--mono);font-size:12px;">${a ? fmt12(a.check_in_time) : '—'}</td>
              <td style="font-size:12px;color:var(--text2);">${a?.note || '—'}</td>
              <td style="font-size:12px;color:var(--text3);">${a?.marked_by || '—'}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table></div>
    </div>
  `
}

// ─── ATTENDANCE VIEW ──────────────────────────────────────────
async function renderAttendanceView(filters = {}) {
  const el = document.getElementById('view-attendance')
  const today = todayStr()
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const from = filters.from || weekAgo
  const to   = filters.to   || today
  const memberFilter = filters.member || ''

  const { data: members } = await supabase.from('members').select('*').eq('active', true).neq('role', 'admin')

  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Attendance</div><div class="page-sub">Full attendance log with date range filter</div></div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" onclick="exportAttendanceCSV()">⬇ Export CSV</button>
        <button class="btn btn-ghost btn-sm" onclick="openManualAtt()">+ Mark manually</button>
      </div>
    </div>
    <div class="card">
      <div class="filters-row">
        <div class="field-group">
          <label class="filter-label">From</label>
          <input type="date" id="att-from" value="${from}" style="max-width:150px;" />
        </div>
        <div class="field-group">
          <label class="filter-label">To</label>
          <input type="date" id="att-to" value="${to}" style="max-width:150px;" />
        </div>
        <div class="field-group">
          <label class="filter-label">Member</label>
          <select id="att-member" style="max-width:160px;">
            <option value="">All members</option>
            ${(members||[]).map(m => `<option value="${m.id}" ${memberFilter===m.id?'selected':''}>${m.name}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="applyAttFilters()" style="align-self:flex-end;">Apply</button>
      </div>
      <div id="attTableWrap"><div class="loading"><div class="spinner"></div> Loading…</div></div>
    </div>
  `
  loadAttendanceTable(from, to, memberFilter)
}

window.applyAttFilters = function() {
  const from   = document.getElementById('att-from')?.value
  const to     = document.getElementById('att-to')?.value
  const member = document.getElementById('att-member')?.value
  loadAttendanceTable(from, to, member)
}

async function loadAttendanceTable(from, to, memberFilter) {
  const el = document.getElementById('attTableWrap')
  let q = supabase.from('attendance').select('*').gte('date', from).lte('date', to).order('date', { ascending: false }).order('member_name')
  if (memberFilter) q = q.eq('member_id', memberFilter)
  const { data } = await q
  const rows = data || []
  el.innerHTML = rows.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Member</th><th>Status</th><th>Check-in</th><th>Note</th><th>Marked by</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td style="font-family:var(--mono);font-size:12px;">${fmtShortDate(r.date)}</td>
          <td>${r.member_name}</td>
          <td>${statusBadge(r.status)}</td>
          <td style="font-family:var(--mono);font-size:12px;">${fmt12(r.check_in_time)}</td>
          <td style="font-size:12px;color:var(--text2);max-width:160px;">${r.note||'—'}</td>
          <td style="font-size:12px;color:var(--text3);">${r.marked_by||'—'}</td>
          <td>
            <div class="action-menu-wrap">
              <button class="btn-action" onclick="toggleMenu(event,'amenu-${r.id}')">•••</button>
              <div class="action-menu" id="amenu-${r.id}">
                <div class="action-item" onclick="openEditAtt('${r.id}')">✏ Edit</div>
                <div class="action-item action-item-danger" onclick="deleteAtt('${r.id}')">🗑 Delete</div>
              </div>
            </div>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : '<div class="empty">No attendance records found for this period.</div>'
}

// ─── PERFORMANCE VIEW ─────────────────────────────────────────
async function renderPerformanceView(filters = {}) {
  const el = document.getElementById('view-performance')
  const today   = todayStr()
  const monthStart = today.slice(0, 8) + '01'
  const from = filters.from || monthStart
  const to   = filters.to   || today

  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Performance</div><div class="page-sub">Attendance statistics per team member</div></div>
      <button class="btn btn-ghost btn-sm" onclick="exportPerformanceCSV()">⬇ Export CSV</button>
    </div>
    <div class="card">
      <div class="filters-row">
        <div class="field-group">
          <label class="filter-label">From</label>
          <input type="date" id="perf-from" value="${from}" style="max-width:150px;" />
        </div>
        <div class="field-group">
          <label class="filter-label">To</label>
          <input type="date" id="perf-to" value="${to}" style="max-width:150px;" />
        </div>
        <button class="btn btn-ghost btn-sm" onclick="applyPerfFilters()" style="align-self:flex-end;">Apply</button>
      </div>
      <div id="perfContent"><div class="loading"><div class="spinner"></div> Loading…</div></div>
    </div>
  `
  loadPerformanceData(from, to)
}

window.applyPerfFilters = function() {
  const from = document.getElementById('perf-from')?.value
  const to   = document.getElementById('perf-to')?.value
  loadPerformanceData(from, to)
}

async function loadPerformanceData(from, to) {
  const el = document.getElementById('perfContent')
  const [membRes, attRes] = await Promise.all([
    supabase.from('members').select('*').eq('active', true).neq('role', 'admin'),
    supabase.from('attendance').select('*').gte('date', from).lte('date', to)
  ])
  const members = membRes.data || []
  const att     = attRes.data  || []

  // Calculate days in range
  const d1 = new Date(from), d2 = new Date(to)
  const totalDays = Math.max(1, Math.round((d2 - d1) / 86400000) + 1)

  const rows = members.map(m => {
    const ma = att.filter(a => a.member_id === m.id)
    const present  = ma.filter(a => a.status === 'present').length
    const late     = ma.filter(a => a.status === 'late').length
    const onLeave  = ma.filter(a => a.status === 'on_leave').length
    const absent   = ma.filter(a => a.status === 'absent').length
    const marked   = ma.length
    const attendRate = totalDays > 0 ? Math.round(((present + late) / totalDays) * 100) : 0
    return { m, present, late, onLeave, absent, marked, attendRate, totalDays }
  })

  if (!rows.length) { el.innerHTML = '<div class="empty">No members found.</div>'; return }

  el.innerHTML = rows.map(({ m, present, late, onLeave, absent, attendRate }) => {
    const barColor = attendRate >= 80 ? 'var(--green)' : attendRate >= 60 ? 'var(--amber)' : 'var(--red)'
    return `<div class="perf-row">
      <div class="perf-avatar">${initials(m.name)}</div>
      <div style="flex:1;min-width:0;">
        <div class="perf-name">${m.name}</div>
        <div class="perf-bar-wrap" style="width:100%;margin-top:5px;">
          <div class="perf-bar" style="width:${attendRate}%;background:${barColor};"></div>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:3px;">${attendRate}% attendance rate · ${totalDays} working days in range</div>
      </div>
      <div class="perf-stats">
        <div class="perf-stat"><div class="perf-stat-val" style="color:var(--green)">${present}</div><div class="perf-stat-lbl">Present</div></div>
        <div class="perf-stat"><div class="perf-stat-val" style="color:var(--amber)">${late}</div><div class="perf-stat-lbl">Late</div></div>
        <div class="perf-stat"><div class="perf-stat-val" style="color:var(--blue)">${onLeave}</div><div class="perf-stat-lbl">Leave</div></div>
        <div class="perf-stat"><div class="perf-stat-val" style="color:var(--red)">${absent}</div><div class="perf-stat-lbl">Absent</div></div>
      </div>
    </div>`
  }).join('')
}

// ─── MEMBERS VIEW ─────────────────────────────────────────────
async function renderMembersView() {
  const el = document.getElementById('view-members')
  el.innerHTML = `
    <div class="page-header"><div><div class="page-title">Members</div><div class="page-sub">Manage team member accounts and devices</div></div><button class="btn btn-primary btn-sm" onclick="openAddMember()">+ Add member</button></div>
    <div class="card"><div id="membersTableWrap"><div class="loading"><div class="spinner"></div> Loading…</div></div></div>
  `
  loadMembersTable()
}

async function loadMembersTable() {
  const { data } = await supabase.from('members').select('*').order('created_at')
  const members  = data || []
  const el = document.getElementById('membersTableWrap')
  el.innerHTML = members.length
    ? `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Device</th><th>Status</th><th></th></tr></thead>
        <tbody>${members.map(m => `<tr>
          <td><div style="display:flex;align-items:center;gap:9px;"><div style="width:28px;height:28px;border-radius:50%;background:var(--purple-bg);color:#a090f8;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:1px solid var(--purple-border);flex-shrink:0;">${initials(m.name)}</div>${m.name}</div></td>
          <td style="font-family:var(--mono);font-size:12px;">@${m.username}</td>
          <td><span class="badge badge-${m.role}">${m.role}</span></td>
          <td>${m.device_fingerprint ? `<span class="badge badge-active">✓ Registered</span>` : '<span class="badge badge-inactive">Not yet</span>'}</td>
          <td><span class="badge badge-${m.active ? 'active' : 'inactive'}">${m.active ? 'Active' : 'Inactive'}</span></td>
          <td>
            <div class="action-menu-wrap">
              <button class="btn-action" onclick="toggleMenu(event,'mmenu-${m.id}')">•••</button>
              <div class="action-menu" id="mmenu-${m.id}">
                <div class="action-item" onclick="resetDevice('${m.id}','${m.name.replace(/'/g,"\\'")}')">🔄 Reset device lock</div>
                <div class="action-item" onclick="resetPassword('${m.id}','${m.username}')">🔑 Reset password</div>
                <div class="action-item" onclick="toggleActive('${m.id}',${m.active})">
                  ${m.active ? '⏸ Deactivate' : '▶ Activate'}
                </div>
                ${m.role !== 'admin' ? `<div class="action-item action-item-danger" onclick="deleteMember('${m.id}','${m.name.replace(/'/g,"\\'")}')">🗑 Delete</div>` : ''}
              </div>
            </div>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`
    : '<div class="empty">No members yet.</div>'
}

// ─── MEMBER ACTIONS ───────────────────────────────────────────
window.openAddMember  = function() { document.getElementById('addMemberModal').style.display = 'flex' }
window.closeAddMember = function() { document.getElementById('addMemberModal').style.display = 'none' }
window.saveAddMember  = async function() {
  const name     = document.getElementById('am-name').value.trim()
  const username = document.getElementById('am-username').value.trim().toLowerCase()
  const pass     = document.getElementById('am-pass').value
  const role     = document.getElementById('am-role').value
  if (!name || !username || !pass) { toast('All fields required', 'error'); return }
  if (pass.length < 6) { toast('Password must be at least 6 characters', 'error'); return }
  const pwHash = await hashPassword(pass)
  const { error } = await supabase.from('members').insert({ name, username, password_hash: pwHash, role })
  if (error?.code === '23505') { toast('Username already taken', 'error'); return }
  if (error) { toast('Error adding member', 'error'); return }
  toast(`${name} added ✓`, 'success')
  closeAddMember()
  ;['am-name','am-pass'].forEach(id => document.getElementById(id).value = '')
  document.getElementById('am-username').value = ''
  loadMembersTable()
}

window.resetDevice = async function(id, name) {
  if (!confirm(`Reset device lock for "${name}"?\n\nThey will be able to log in from any device and a new device lock will be set on their next login.`)) return
  await supabase.from('members').update({ device_fingerprint: null, device_approved: false }).eq('id', id)
  await supabase.from('sessions').delete().eq('member_id', id)
  toast(`Device lock reset for ${name} ✓`, 'success'); loadMembersTable()
}

window.resetPassword = async function(id, username) {
  const newPass = prompt(`Set new password for @${username}:`)
  if (!newPass?.trim()) return
  if (newPass.length < 6) { toast('Password must be at least 6 characters', 'error'); return }
  const pwHash = await hashPassword(newPass)
  await supabase.from('members').update({ password_hash: pwHash }).eq('id', id)
  await supabase.from('sessions').delete().eq('member_id', id)
  toast('Password reset ✓', 'success')
}

window.toggleActive = async function(id, current) {
  await supabase.from('members').update({ active: !current }).eq('id', id)
  if (current) await supabase.from('sessions').delete().eq('member_id', id)
  toast(current ? 'Member deactivated' : 'Member activated', 'success'); loadMembersTable()
}

window.deleteMember = async function(id, name) {
  if (!confirm(`Permanently delete "${name}"?\n\nThis will also delete all their attendance records.\nThis cannot be undone.`)) return
  await supabase.from('attendance').delete().eq('member_id', id)
  await supabase.from('sessions').delete().eq('member_id', id)
  await supabase.from('members').delete().eq('id', id)
  toast(`${name} deleted`, 'success'); loadMembersTable()
}

// ─── ATTENDANCE EDIT ──────────────────────────────────────────
window.openEditAtt = async function(id) {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'))
  const { data } = await supabase.from('attendance').select('*').eq('id', id).single()
  if (!data) return
  document.getElementById('ea-id').value     = data.id
  document.getElementById('ea-member').value = data.member_name
  document.getElementById('ea-date').value   = data.date
  document.getElementById('ea-status').value = data.status
  document.getElementById('ea-checkin').value = data.check_in_time ? new Date(data.check_in_time).toTimeString().slice(0,5) : ''
  document.getElementById('ea-note').value   = data.note || ''
  document.getElementById('editAttModal').style.display = 'flex'
}
window.closeEditAtt = function() { document.getElementById('editAttModal').style.display = 'none' }
window.saveEditAtt  = async function() {
  const id     = document.getElementById('ea-id').value
  const date   = document.getElementById('ea-date').value
  const timeVal = document.getElementById('ea-checkin').value
  const updates = {
    date,
    status:        document.getElementById('ea-status').value,
    check_in_time: timeVal ? new Date(`${date}T${timeVal}`).toISOString() : null,
    note:          document.getElementById('ea-note').value.trim() || null,
    marked_by:     'admin',
  }
  await supabase.from('attendance').update(updates).eq('id', id)
  closeEditAtt(); toast('Record updated ✓', 'success')
  loadAttendanceTable(
    document.getElementById('att-from')?.value || todayStr(),
    document.getElementById('att-to')?.value   || todayStr(),
    document.getElementById('att-member')?.value || ''
  )
}

window.deleteAtt = async function(id) {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'))
  if (!confirm('Delete this attendance record?')) return
  await supabase.from('attendance').delete().eq('id', id)
  toast('Deleted', 'success')
  loadAttendanceTable(
    document.getElementById('att-from')?.value || todayStr(),
    document.getElementById('att-to')?.value   || todayStr(),
    document.getElementById('att-member')?.value || ''
  )
}

// ─── MANUAL ATTENDANCE ────────────────────────────────────────
window.openManualAtt = async function() {
  const { data: members } = await supabase.from('members').select('*').eq('active', true).neq('role', 'admin')
  const sel = document.getElementById('ma-member')
  sel.innerHTML = (members||[]).map(m => `<option value="${m.id}" data-name="${m.name}">${m.name}</option>`).join('')
  document.getElementById('ma-date').value    = todayStr()
  document.getElementById('ma-checkin').value = ''
  document.getElementById('ma-note').value    = ''
  document.getElementById('manualAttModal').style.display = 'flex'
}
window.closeManualAtt = function() { document.getElementById('manualAttModal').style.display = 'none' }
window.saveManualAtt  = async function() {
  const selEl   = document.getElementById('ma-member')
  const memberId = selEl.value
  const memberName = selEl.options[selEl.selectedIndex]?.dataset.name || ''
  const date    = document.getElementById('ma-date').value
  const status  = document.getElementById('ma-status').value
  const timeVal = document.getElementById('ma-checkin').value
  const note    = document.getElementById('ma-note').value.trim() || null
  if (!memberId || !date) { toast('Member and date required', 'error'); return }

  const row = {
    member_id:    memberId,
    member_name:  memberName,
    date,
    check_in_time: timeVal ? new Date(`${date}T${timeVal}`).toISOString() : null,
    status,
    note,
    marked_by: 'admin',
  }
  const { error } = await supabase.from('attendance').upsert(row, { onConflict: 'member_id,date' })
  if (error) { toast('Error saving attendance', 'error'); return }
  closeManualAtt(); toast('Attendance marked ✓', 'success')
  if (adminView === 'dashboard')  renderDashboard()
  if (adminView === 'attendance') renderAttendanceView()
}

// ─── CSV EXPORTS ──────────────────────────────────────────────
window.exportAttendanceCSV = async function() {
  const from   = document.getElementById('att-from')?.value || todayStr()
  const to     = document.getElementById('att-to')?.value   || todayStr()
  const member = document.getElementById('att-member')?.value || ''
  let q = supabase.from('attendance').select('*').gte('date', from).lte('date', to).order('date', { ascending: false })
  if (member) q = q.eq('member_id', member)
  const { data } = await q
  if (!data?.length) { toast('No data to export', 'error'); return }
  const headers = ['Date', 'Member', 'Status', 'Check-in Time', 'Note', 'Marked By']
  const rows = data.map(r => [
    r.date, r.member_name, r.status,
    r.check_in_time ? fmt12(r.check_in_time) : '',
    r.note || '', r.marked_by || ''
  ])
  downloadCSV(`attendance_${from}_to_${to}.csv`, headers, rows)
  toast('CSV downloaded ✓', 'success')
}

window.exportPerformanceCSV = async function() {
  const from = document.getElementById('perf-from')?.value || todayStr()
  const to   = document.getElementById('perf-to')?.value   || todayStr()
  const [membRes, attRes] = await Promise.all([
    supabase.from('members').select('*').eq('active', true).neq('role', 'admin'),
    supabase.from('attendance').select('*').gte('date', from).lte('date', to)
  ])
  const members = membRes.data || []; const att = attRes.data || []
  const d1 = new Date(from), d2 = new Date(to)
  const totalDays = Math.max(1, Math.round((d2 - d1) / 86400000) + 1)
  const headers = ['Member', 'Present', 'Late', 'On Leave', 'Absent', 'Total Days', 'Attendance Rate %']
  const rows = members.map(m => {
    const ma = att.filter(a => a.member_id === m.id)
    const p = ma.filter(a => a.status === 'present').length
    const l = ma.filter(a => a.status === 'late').length
    const o = ma.filter(a => a.status === 'on_leave').length
    const ab = ma.filter(a => a.status === 'absent').length
    const rate = Math.round(((p + l) / totalDays) * 100)
    return [m.name, p, l, o, ab, totalDays, rate + '%']
  })
  downloadCSV(`performance_${from}_to_${to}.csv`, headers, rows)
  toast('CSV downloaded ✓', 'success')
}

function downloadCSV(filename, headers, rows) {
  const escape = v => `"${String(v).replace(/"/g, '""')}"`
  const lines  = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))]
  const blob   = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement('a'); a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
}

// ─── Start ────────────────────────────────────────────────────
boot()
