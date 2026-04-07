import './style.css'
import { supabase }                      from './supabase.js'
import { getDeviceFingerprint, hashPassword } from './fingerprint.js'

// ─── State ────────────────────────────────────────────────────
let currentUser  = null
let currentToken = null
let deviceFP     = null
let officeStart      = '09:00'   // HH:MM
let officeEnd        = '18:00'   // HH:MM
let absentAfterHours = 2          // hours after start before auto-absent
let adminView    = 'dashboard'

// ─── Boot ─────────────────────────────────────────────────────
async function boot() {
  deviceFP = await getDeviceFingerprint()
  const t  = localStorage.getItem('hq_token')
  if (t && await resumeSession(t)) return
  renderLogin()
}

async function resumeSession(token) {
  const { data } = await supabase
    .from('sessions').select('*, members(*)')
    .eq('token', token).gt('expires_at', nowStr()).single()
  if (!data?.members) return false
  if (data.device_fingerprint && data.device_fingerprint !== deviceFP) {
    localStorage.removeItem('hq_token'); return false
  }
  currentUser  = data.members
  currentToken = token
  await loadOfficeTime()
  if (isAdmin()) renderAdmin()
  else            renderMemberPage()
  return true
}

// ─── Helpers ──────────────────────────────────────────────────
const nowStr    = () => new Date().toISOString()
const todayStr  = () => new Date().toISOString().slice(0, 10)
const initials  = n => n.trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
const fmt12     = ts => ts ? new Date(ts).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' }) : '—'
const fmtShort  = d  => d  ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) : '—'
const isAdmin   = () => currentUser?.role === 'admin' || currentUser?.role === 'superadmin'
const isSuperAdmin = () => currentUser?.role === 'superadmin'
const rand = (n=32) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b=>b.toString(16).padStart(2,'0')).join('')

async function loadOfficeTime() {
  const { data: rows } = await supabase.from('settings').select('*').in('key',['office_start_time','office_end_time','absent_after_hours'])
  if (!rows) return
  for (const r of rows) {
    const v = typeof r.value === 'string' ? r.value.replace(/"/g,'') : r.value
    if (r.key === 'office_start_time')  officeStart      = v
    if (r.key === 'office_end_time')    officeEnd        = v
    if (r.key === 'absent_after_hours') absentAfterHours = Number(v) || 2
  }
}

function isLate(checkinTime) {
  if (!checkinTime) return false
  const [oh, om] = officeStart.split(':').map(Number)
  const d = new Date(checkinTime)
  return d.getHours() > oh || (d.getHours() === oh && d.getMinutes() > om)
}
// 'on_time' status: checked in at or before officeStart
function checkinStatus(checkinTime) {
  if (!checkinTime) return 'absent'
  return isLate(checkinTime) ? 'late' : 'on_time'
}

function statusBadge(s) {
  const map = { on_time:'🟢 On time', present:'✅ Present', late:'🕐 Late', absent:'❌ Absent', on_leave:'🏖 On Leave' }
  return `<span class="badge b-${s}">${map[s]||s}</span>`
}

function toast(msg, type='default') {
  let t = document.getElementById('_toast')
  if (!t) { t=document.createElement('div'); t.id='_toast'; t.className='toast'; document.body.appendChild(t) }
  t.textContent = msg
  t.style.borderColor = type==='error' ? 'var(--red)' : type==='success' ? 'var(--teal-border)' : 'var(--border2)'
  t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 2800)
}

// ─── LOGIN ────────────────────────────────────────────────────
function renderLogin() {
  document.getElementById('app').innerHTML = `
  <div class="login-page">
    <div class="login-box">
      <div class="login-logo-row">
        <div class="login-logo-icon">⏱</div>
        <div>
          <div class="login-logo-name">Haazri HQ</div>
          <div class="login-logo-sub">attendance</div>
        </div>
      </div>
      <div class="login-form-title">Welcome back</div>
      <div class="login-form-sub">Sign in to continue.</div>
      <div id="loginErr" class="error-banner"></div>
      <div class="field-group">
        <label class="field-label">Username</label>
        <input type="text" id="lu" placeholder="your username" autocomplete="username" />
      </div>
      <div class="field-group">
        <label class="field-label">Password</label>
        <input type="password" id="lp" placeholder="••••••••" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()" />
      </div>
      <button class="btn btn-primary btn-full" id="loginBtn" onclick="doLogin()">Sign in</button>
      <div class="login-note">First sign-in registers your device.<br>Only that device may be used for future logins.</div>
    </div>
  </div>`
}

window.doLogin = async function() {
  const username = document.getElementById('lu').value.trim().toLowerCase()
  const password = document.getElementById('lp').value
  const errEl    = document.getElementById('loginErr')
  const btn      = document.getElementById('loginBtn')
  if (!username || !password) { errEl.textContent='Please fill in both fields.'; errEl.classList.add('show'); return }
  btn.disabled = true; btn.textContent = 'Signing in…'; errEl.classList.remove('show')

  const pwHash = await hashPassword(password)
  const { data: member } = await supabase.from('members').select('*')
    .eq('username', username).eq('password_hash', pwHash).eq('active', true).single()

  if (!member) {
    errEl.textContent = 'Incorrect username or password.'; errEl.classList.add('show')
    btn.disabled = false; btn.textContent = 'Sign in'; return
  }

  // Device lock check
  if (member.device_fingerprint && member.device_fingerprint !== deviceFP) {
    errEl.textContent = '🔒 This account is locked to a different device. Contact your admin.'
    errEl.classList.add('show'); btn.disabled = false; btn.textContent = 'Sign in'; return
  }
  // First login — register device
  if (!member.device_fingerprint) {
    await supabase.from('members').update({ device_fingerprint: deviceFP, device_approved: true }).eq('id', member.id)
    member.device_fingerprint = deviceFP
  }

  const token   = rand()
  const expires = new Date(Date.now() + 30*24*60*60*1000).toISOString()
  await supabase.from('sessions').insert({ member_id: member.id, token, device_fingerprint: deviceFP, expires_at: expires })
  localStorage.setItem('hq_token', token)
  currentUser = member; currentToken = token
  await loadOfficeTime()
  if (isAdmin()) renderAdmin()
  else            renderMemberPage()
}

window.doLogout = async function() {
  if (currentToken) await supabase.from('sessions').delete().eq('token', currentToken)
  localStorage.removeItem('hq_token')
  currentUser = currentToken = null
  renderLogin()
}

// ─── MEMBER CHECK-IN / CHECK-OUT PAGE ─────────────────────────
async function renderMemberPage() {
  const today = todayStr()
  const { data: record } = await supabase.from('attendance')
    .select('*').eq('member_id', currentUser.id).eq('date', today).single()

  document.getElementById('app').innerHTML = `
  <div class="checkin-page">
    <div class="checkin-card">
      <div class="checkin-topbar">
        <div class="checkin-logo">
          <div class="checkin-logo-icon">⏱</div>
          <div class="checkin-logo-name">Haazri HQ</div>
        </div>
        <span class="logout-link" onclick="doLogout()">Sign out</span>
      </div>

      <div class="member-greeting">
        <div class="member-avatar-lg">${initials(currentUser.name)}</div>
        <div class="member-name-lg">${currentUser.name}</div>
      </div>

      <div class="clock-display">
        <div class="clock-time" id="lc">--:--:--</div>
        <div class="clock-date" id="ld"></div>
        <div class="clock-office">Office starts at <strong>${officeStart}</strong></div>
      </div>

      <div id="attendanceContent"></div>
    </div>
  </div>`

  setInterval(tickClock, 1000); tickClock()
  renderAttendanceContent(record)
}

function tickClock() {
  const el = document.getElementById('lc'); const de = document.getElementById('ld')
  if (!el) return
  const n = new Date()
  el.textContent = n.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
  if (de) de.textContent = n.toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
}

function renderAttendanceContent(record) {
  const el = document.getElementById('attendanceContent'); if (!el) return

  if (record) {
    const statusConf = {
      on_time: { cls:'sr-present', icon:'🟢', label:'Present · On time', color:'var(--green)' },
      present: { cls:'sr-present', icon:'✅', label:'Present',            color:'var(--green)' },
      late:    { cls:'sr-late',    icon:'🕐', label:'Present · Late',     color:'var(--amber)' },
      absent:  { cls:'sr-absent',  icon:'❌', label:'Absent',             color:'var(--red)'   },
      on_leave:{ cls:'sr-leave',   icon:'🏖', label:'On Leave',           color:'var(--blue)'  },
    }
    const sc = statusConf[record.status] || statusConf.present
    const checkedOut = !!record.check_out_time
    el.innerHTML = `
      <div class="status-result ${sc.cls}">
        <div class="sr-icon">${sc.icon}</div>
        <div class="sr-status" style="color:${sc.color};">${sc.label}</div>
        <div class="sr-time">
          ${record.check_in_time ? `Checked in at ${fmt12(record.check_in_time)}` : ''}
          ${checkedOut ? ` · Out at ${fmt12(record.check_out_time)}` : ''}
        </div>
      </div>
      ${!checkedOut && (record.status === 'present' || record.status === 'late' || record.status === 'on_time') ? `
        <button class="btn btn-amber btn-full" onclick="doCheckOut('${record.id}')">
          🚪 Check out
        </button>
        <div style="font-size:11.5px;color:var(--text3);text-align:center;margin-top:8px;">
          Tap when leaving for the day
        </div>
      ` : checkedOut ? `
        <div style="text-align:center;font-size:13px;color:var(--text3);padding:10px 0;">
          ✅ All done for today. See you tomorrow!
        </div>
      ` : ''}
    `
  } else {
    el.innerHTML = `
      <div style="font-size:13px;color:var(--text2);text-align:center;margin-bottom:16px;">
        You have not checked in yet today.
      </div>
      <button class="btn btn-primary btn-full" onclick="doCheckIn()">
        ✅ Check in
      </button>
    `
  }
}

let pickedStatus = 'present'
window.pickStatus = function(s) { pickedStatus = s }

window.doCheckIn = async function() {
  const btn = document.getElementById('ciBtn')
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…' }
  const checkInTime = new Date().toISOString()
  // on_time = checked in on time, late = checked in late; both are PRESENT
  const finalStatus = checkinStatus(checkInTime)
  const note = null

  const row = {
    member_id:    currentUser.id,
    member_name:  currentUser.name,
    date:         todayStr(),
    check_in_time: (pickedStatus === 'present' || pickedStatus === 'late') ? checkInTime : null,
    status:       finalStatus,
    note,
    marked_by:    'self',
  }
  const { error } = await supabase.from('attendance').insert(row)
  if (error) { toast('Error saving — try again', 'error'); btn.disabled = false; btn.textContent = '✅ Check in'; return }
  toast('Attendance recorded ✓', 'success')
  // Re-fetch and re-render
  const { data: record } = await supabase.from('attendance')
    .select('*').eq('member_id', currentUser.id).eq('date', todayStr()).single()
  renderAttendanceContent(record)
}

window.doCheckOut = async function(id) {
  const checkOutTime = new Date().toISOString()
  const { error } = await supabase.from('attendance').update({ check_out_time: checkOutTime }).eq('id', id)
  if (error) { toast('Error saving check-out', 'error'); return }
  toast('Checked out ✓', 'success')
  const { data: record } = await supabase.from('attendance')
    .select('*').eq('member_id', currentUser.id).eq('date', todayStr()).single()
  renderAttendanceContent(record)
}

// ─── ADMIN SHELL ──────────────────────────────────────────────
function renderAdmin() {
  document.getElementById('app').innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sb-logo">
        <div class="sb-logo-icon">⏱</div>
        <div>
          <div class="sb-logo-name">Haazri HQ</div>
          <div class="sb-logo-sub">admin panel</div>
        </div>
      </div>
      <div class="nav-sec">Overview</div>
      <div class="nav-item active" data-view="dashboard" onclick="go('dashboard')">
        <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
        Dashboard
      </div>
      <div class="nav-sec">Records</div>
      <div class="nav-item" data-view="attendance" onclick="go('attendance')">
        <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v4M11 1v4M2 7h12"/></svg>
        Attendance
      </div>
      <div class="nav-item" data-view="performance" onclick="go('performance')">
        <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12L5 8L8 10L11 5L14 7"/></svg>
        Performance
      </div>
      <div class="nav-sec">Admin</div>
      <div class="nav-item" data-view="members" onclick="go('members')">
        <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="5" r="3"/><path d="M1 14c0-3 2.5-4.5 5-4.5s5 1.5 5 4.5"/><circle cx="12" cy="5" r="2"/><path d="M11 12c1.5 0 4 .8 4 3"/></svg>
        Members
      </div>
      <div class="nav-item" data-view="settings" onclick="go('settings')">
        <svg class="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 2v1M8 13v1M2 8h1M13 8h1M3.5 3.5l.7.7M11.8 11.8l.7.7M3.5 12.5l.7-.7M11.8 4.2l.7-.7"/></svg>
        Settings
      </div>
      <div class="sb-footer">
        <div class="sb-user-name">${currentUser.name}</div>
        <div class="sb-user-role">${currentUser.role}</div>
        <button class="sb-logout" onclick="doLogout()">Sign out</button>
      </div>
    </aside>
    <main class="main">
      <div class="view active" id="view-dashboard"></div>
      <div class="view" id="view-attendance"></div>
      <div class="view" id="view-performance"></div>
      <div class="view" id="view-members"></div>
      <div class="view" id="view-settings"></div>
    </main>
  </div>

  <!-- ADD MEMBER MODAL -->
  <div class="modal-overlay" id="addMemberModal" style="display:none;">
    <div class="modal">
      <div class="modal-title">Add team member</div>
      <div class="two-col">
        <div class="fg"><label class="field-label">Full name</label><input type="text" id="am-name" placeholder="Hamza Khan" /></div>
        <div class="fg"><label class="field-label">Username</label><input type="text" id="am-user" placeholder="hamza" /></div>
        <div class="fg"><label class="field-label">Password</label><input type="password" id="am-pass" placeholder="min 6 chars" /></div>
        <div class="fg"><label class="field-label">Role</label>
          <select id="am-role">
            <option value="member">Member</option>
            ${isSuperAdmin() ? '<option value="admin">Admin</option>' : ''}
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeM('addMemberModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveNewMember()">Add member</button>
      </div>
    </div>
  </div>

  <!-- EDIT ATTENDANCE MODAL -->
  <div class="modal-overlay" id="editAttModal" style="display:none;">
    <div class="modal">
      <div class="modal-title">Edit attendance record</div>
      <input type="hidden" id="ea-id" />
      <div class="two-col">
        <div class="fg full"><label class="field-label">Member</label><input id="ea-mem" disabled /></div>
        <div class="fg"><label class="field-label">Date</label><input type="date" id="ea-date" /></div>
        <div class="fg"><label class="field-label">Status</label>
          <select id="ea-status">
            <option value="on_time">🟢 On time (present)</option>
            <option value="present">✅ Present</option>
            <option value="late">🕐 Late (present)</option>
            <option value="on_leave">🏖 On Leave</option>
            <option value="absent">❌ Absent</option>
          </select>
        </div>
        <div class="fg"><label class="field-label">Check-in time</label><input type="time" id="ea-cin" /></div>
        <div class="fg"><label class="field-label">Check-out time</label><input type="time" id="ea-cout" /></div>
        <div class="fg full"><label class="field-label">Note</label><textarea id="ea-note" style="min-height:55px;"></textarea></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeM('editAttModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveEditAtt()">Save changes</button>
      </div>
    </div>
  </div>

  <!-- MANUAL ATTENDANCE MODAL -->
  <div class="modal-overlay" id="manualAttModal" style="display:none;">
    <div class="modal">
      <div class="modal-title">Mark attendance manually</div>
      <div class="two-col">
        <div class="fg"><label class="field-label">Member</label><select id="ma-mem"></select></div>
        <div class="fg"><label class="field-label">Date</label><input type="date" id="ma-date" /></div>
        <div class="fg"><label class="field-label">Status</label>
          <select id="ma-status">
            <option value="on_time">🟢 On time (present)</option>
            <option value="present">✅ Present</option>
            <option value="late">🕐 Late (present)</option>
            <option value="on_leave">🏖 On Leave</option>
            <option value="absent">❌ Absent</option>
          </select>
        </div>
        <div class="fg"><label class="field-label">Check-in time (optional)</label><input type="time" id="ma-cin" /></div>
        <div class="fg full"><label class="field-label">Note</label><textarea id="ma-note" style="min-height:50px;"></textarea></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeM('manualAttModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveManualAtt()">Mark attendance</button>
      </div>
    </div>
  </div>

  <div class="toast" id="_toast"></div>`

  go('dashboard')
}

window.go = function(v) {
  adminView = v
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'))
  document.getElementById('view-' + v)?.classList.add('active')
  document.querySelectorAll('.nav-item[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === v))
  if (v === 'dashboard')   loadDashboard()
  if (v === 'attendance')  loadAttendance()
  if (v === 'performance') loadPerformance()
  if (v === 'members')     loadMembers()
  if (v === 'settings')    loadSettings()
}

window.closeM = id => { document.getElementById(id).style.display = 'none' }
window.toggleMenu = function(e, id) {
  e.stopPropagation()
  document.querySelectorAll('.action-menu.open').forEach(m => { if (m.id !== id) m.classList.remove('open') })
  document.getElementById(id)?.classList.toggle('open')
}
document.addEventListener('click', () => document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open')))

// ─── DASHBOARD ────────────────────────────────────────────────
// Silent auto-absent — runs on dashboard load without toast
async function _silentAutoAbsent() {
  const today    = todayStr()
  const now      = new Date()
  const [oh, om] = officeStart.split(':').map(Number)
  const cutoff   = new Date()
  cutoff.setHours(oh + absentAfterHours, om, 0, 0)
  if (now < cutoff) return  // cutoff not reached
  const { data: members }  = await supabase.from('members').select('id,name').eq('active',true).not('role','in','("superadmin","admin")')
  const { data: existing } = await supabase.from('attendance').select('member_id').eq('date', today)
  const checkedInIds = new Set((existing||[]).map(a=>a.member_id))
  const toMark = (members||[]).filter(m => !checkedInIds.has(m.id))
  if (!toMark.length) return
  const rows = toMark.map(m => ({ member_id:m.id, member_name:m.name, date:today, status:'absent', marked_by:'auto' }))
  await supabase.from('attendance').upsert(rows, { onConflict:'member_id,date' })
}

async function loadDashboard() {
  const el = document.getElementById('view-dashboard')
  const today = todayStr()
  // Auto-mark absent silently when dashboard loads
  await _silentAutoAbsent()
  el.innerHTML = `<div class="page-header"><div><div class="page-title">Dashboard</div><div class="page-sub">${new Date().toLocaleDateString('en-US',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div></div><button class="btn btn-ghost btn-sm" onclick="openManualAtt()">+ Mark manually</button></div><div class="loading"><div class="spinner"></div> Loading…</div>`

  const [{ data: members }, { data: att }] = await Promise.all([
    supabase.from('members').select('*').eq('active',true).neq('role','superadmin').neq('role','admin'),
    supabase.from('attendance').select('*').eq('date', today)
  ])
  const presentAll = att?.filter(a=>['present','on_time','late'].includes(a.status)).length || 0
  const late      = att?.filter(a=>a.status==='late').length || 0
  const onTime    = att?.filter(a=>a.status==='on_time').length || 0
  const onLeave   = att?.filter(a=>a.status==='on_leave').length || 0
  const absent    = att?.filter(a=>a.status==='absent').length   || 0
  const notMarked = (members||[]).filter(m => !att?.find(a=>a.member_id===m.id)).length

  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Dashboard</div><div class="page-sub">${new Date().toLocaleDateString('en-US',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div></div>
      <button class="btn btn-ghost btn-sm" onclick="openManualAtt()">+ Mark manually</button>
    </div>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--green)"></div><div class="stat-label">Present</div><div class="stat-value" style="color:var(--green)">${presentAll}</div></div>
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--teal)"></div><div class="stat-label">On time</div><div class="stat-value" style="color:var(--teal)">${onTime}</div></div>
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--amber)"></div><div class="stat-label">Late</div><div class="stat-value" style="color:var(--amber)">${late}</div></div>
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--blue)"></div><div class="stat-label">On Leave</div><div class="stat-value" style="color:var(--blue)">${onLeave}</div></div>
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--red)"></div><div class="stat-label">Absent</div><div class="stat-value" style="color:var(--red)">${absent}</div></div>
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--teal)"></div><div class="stat-label">Not marked</div><div class="stat-value" style="color:var(--teal)">${notMarked}</div></div>
      <div class="stat-box"><div class="stat-box-accent" style="background:var(--text3)"></div><div class="stat-label">Total</div><div class="stat-value">${(members||[]).length}</div></div>
    </div>
    <div class="card">
      <div class="card-hdr"><span class="card-title">Today · ${today}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Member</th><th>Status</th><th>Check-in</th><th>Check-out</th><th>Note</th><th>By</th></tr></thead>
        <tbody>${(members||[]).map(m=>{
          const a = att?.find(x=>x.member_id===m.id)
          return `<tr>
            <td><div style="display:flex;align-items:center;gap:9px;"><div class="avatar-sm">${initials(m.name)}</div>${m.name}</div></td>
            <td>${a ? statusBadge(a.status) : '<span style="color:var(--text3);font-size:12px;">—</span>'}</td>
            <td style="font-family:var(--mono);font-size:12px;">${a ? fmt12(a.check_in_time) : '—'}</td>
            <td style="font-family:var(--mono);font-size:12px;">${a?.check_out_time ? fmt12(a.check_out_time) : '—'}</td>
            <td style="font-size:12px;color:var(--text2);">${a?.note||'—'}</td>
            <td style="font-size:12px;color:var(--text3);">${a?.marked_by||'—'}</td>
          </tr>`
        }).join('')}</tbody>
      </table></div>
    </div>`
}

// ─── ATTENDANCE ───────────────────────────────────────────────
async function loadAttendance(f={}) {
  const el    = document.getElementById('view-attendance')
  const today = todayStr()
  const from  = f.from  || new Date(Date.now()-7*86400000).toISOString().slice(0,10)
  const to    = f.to    || today
  const memF  = f.mem   || ''

  const { data: members } = await supabase.from('members').select('*').eq('active',true).neq('role','superadmin').neq('role','admin')

  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Attendance log</div><div class="page-sub">Full history with date range filter</div></div>
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm" onclick="exportAttCSV()">⬇ CSV</button>
        <button class="btn btn-ghost btn-sm" onclick="openManualAtt()">+ Mark manually</button>
      </div>
    </div>
    <div class="card">
      <div class="filters-row">
        <div class="fg"><label class="field-label">From</label><input type="date" id="af-from" value="${from}" style="max-width:148px;" /></div>
        <div class="fg"><label class="field-label">To</label><input type="date" id="af-to" value="${to}" style="max-width:148px;" /></div>
        <div class="fg"><label class="field-label">Member</label>
          <select id="af-mem" style="max-width:160px;">
            <option value="">All members</option>
            ${(members||[]).map(m=>`<option value="${m.id}" ${memF===m.id?'selected':''}>${m.name}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="applyAttFilters()" style="align-self:flex-end;">Apply</button>
      </div>
      <div id="attTbl"><div class="loading"><div class="spinner"></div> Loading…</div></div>
    </div>`
  fillAttTable(from, to, memF)
}

window.applyAttFilters = () => fillAttTable(
  document.getElementById('af-from')?.value,
  document.getElementById('af-to')?.value,
  document.getElementById('af-mem')?.value
)

async function fillAttTable(from, to, memF) {
  let q = supabase.from('attendance').select('*').gte('date',from).lte('date',to).order('date',{ascending:false})
  if (memF) q = q.eq('member_id', memF)
  const { data: rows } = await q
  const el = document.getElementById('attTbl')
  if (!el) return
  el.innerHTML = (rows||[]).length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Member</th><th>Status</th><th>Check-in</th><th>Check-out</th><th>Note</th><th>By</th><th></th></tr></thead>
      <tbody>${(rows||[]).map(r=>`<tr>
        <td style="font-family:var(--mono);font-size:12px;">${fmtShort(r.date)}</td>
        <td>${r.member_name}</td>
        <td>${statusBadge(r.status)}</td>
        <td style="font-family:var(--mono);font-size:12px;">${fmt12(r.check_in_time)}</td>
        <td style="font-family:var(--mono);font-size:12px;">${r.check_out_time ? fmt12(r.check_out_time) : '—'}</td>
        <td style="font-size:12px;color:var(--text2);max-width:150px;">${r.note||'—'}</td>
        <td style="font-size:12px;color:var(--text3);">${r.marked_by||'—'}</td>
        <td>
          <div class="action-menu-wrap">
            <button class="btn-action" onclick="toggleMenu(event,'ra-${r.id}')">•••</button>
            <div class="action-menu" id="ra-${r.id}">
              <div class="action-item" onclick="openEditAtt('${r.id}')">✏ Edit</div>
              <div class="action-item action-item-danger" onclick="delAtt('${r.id}')">🗑 Delete</div>
            </div>
          </div>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">No records for this period.</div>'
}

// ─── PERFORMANCE ──────────────────────────────────────────────
async function loadPerformance(f={}) {
  const el    = document.getElementById('view-performance')
  const today = todayStr()
  const from  = f.from || today.slice(0,8)+'01'
  const to    = f.to   || today

  el.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Performance</div><div class="page-sub">Attendance statistics by member and date range</div></div>
      <button class="btn btn-ghost btn-sm" onclick="exportPerfCSV()">⬇ CSV</button>
    </div>
    <div class="card">
      <div class="filters-row">
        <div class="fg"><label class="field-label">From</label><input type="date" id="pf-from" value="${from}" style="max-width:148px;" /></div>
        <div class="fg"><label class="field-label">To</label><input type="date" id="pf-to" value="${to}" style="max-width:148px;" /></div>
        <button class="btn btn-ghost btn-sm" onclick="applyPerfFilters()" style="align-self:flex-end;">Apply</button>
      </div>
      <div id="perfRows"><div class="loading"><div class="spinner"></div> Loading…</div></div>
    </div>`
  fillPerfRows(from, to)
}

window.applyPerfFilters = () => fillPerfRows(
  document.getElementById('pf-from')?.value,
  document.getElementById('pf-to')?.value
)

async function fillPerfRows(from, to) {
  const [{ data: members }, { data: att }] = await Promise.all([
    supabase.from('members').select('*').eq('active',true).neq('role','superadmin').neq('role','admin'),
    supabase.from('attendance').select('*').gte('date',from).lte('date',to)
  ])
  const d1 = new Date(from), d2 = new Date(to)
  const totalDays = Math.max(1, Math.round((d2-d1)/86400000)+1)
  const el = document.getElementById('perfRows'); if (!el) return

  const rows = (members||[]).map(m => {
    const ma = (att||[]).filter(a=>a.member_id===m.id)
    const p  = ma.filter(a=>a.status==='present'||a.status==='on_time').length
    const l  = ma.filter(a=>a.status==='late').length
    const o  = ma.filter(a=>a.status==='on_leave').length
    const ab = ma.filter(a=>a.status==='absent').length
    const rate = Math.round(((p+l)/totalDays)*100)
    const barCol = rate>=80?'var(--green)':rate>=60?'var(--amber)':'var(--red)'
    return `<div class="perf-member-row">
      <div class="perf-av">${initials(m.name)}</div>
      <div style="flex:1;min-width:0;">
        <div class="perf-name">${m.name}</div>
        <div class="rate-bar-wrap" style="width:min(200px,100%);margin-top:5px;">
          <div class="rate-bar" style="width:${rate}%;background:${barCol};"></div>
        </div>
        <div class="perf-meta">${rate}% attendance · ${totalDays} days</div>
      </div>
      <div class="perf-stats">
        <div class="ps"><div class="ps-val" style="color:var(--green)">${p}</div><div class="ps-lbl">Present</div></div>
        <div class="ps"><div class="ps-val" style="color:var(--amber)">${l}</div><div class="ps-lbl">Late</div></div>
        <div class="ps"><div class="ps-val" style="color:var(--blue)">${o}</div><div class="ps-lbl">Leave</div></div>
        <div class="ps"><div class="ps-val" style="color:var(--red)">${ab}</div><div class="ps-lbl">Absent</div></div>
      </div>
    </div>`
  })
  el.innerHTML = rows.length ? rows.join('') : '<div class="empty">No members found.</div>'
}

// ─── MEMBERS ──────────────────────────────────────────────────
async function loadMembers() {
  const el = document.getElementById('view-members')
  el.innerHTML = `<div class="page-header"><div><div class="page-title">Members</div><div class="page-sub">Manage accounts, device locks and roles</div></div><button class="btn btn-primary btn-sm" onclick="openAddMember()">+ Add member</button></div><div class="card"><div id="memTbl"><div class="loading"><div class="spinner"></div></div></div></div>`
  fillMembersTable()
}

async function fillMembersTable() {
  const { data: all } = await supabase.from('members').select('*').order('created_at')
  const el = document.getElementById('memTbl'); if (!el) return
  el.innerHTML = (all||[]).length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Device</th><th>Status</th><th></th></tr></thead>
      <tbody>${(all||[]).map(m=>{
        const isSelf        = m.id === currentUser?.id
        const isTheSuperadmin = m.role === 'superadmin'
        const canEdit       = isSuperAdmin() || (!isTheSuperadmin && m.role !== 'admin')
        const canDelete     = isSuperAdmin() && !isSelf
        return `<tr>
          <td><div style="display:flex;align-items:center;gap:9px;"><div class="avatar-sm">${initials(m.name)}</div>${m.name}${isSelf?' <span style="font-size:10px;color:var(--text3);">(you)</span>':''}</div></td>
          <td style="font-family:var(--mono);font-size:12px;">@${m.username}</td>
          <td><span class="badge b-${m.role}">${m.role}</span></td>
          <td>${m.device_fingerprint?'<span class="badge b-active">✓ Registered</span>':'<span class="badge b-inactive">Not set</span>'}</td>
          <td><span class="badge b-${m.active?'active':'inactive'}">${m.active?'Active':'Inactive'}</span></td>
          <td>
            ${canEdit||canDelete ? `<div class="action-menu-wrap">
              <button class="btn-action" onclick="toggleMenu(event,'mm-${m.id}')">•••</button>
              <div class="action-menu" id="mm-${m.id}">
                ${canEdit?`<div class="action-item" onclick="resetDevice('${m.id}','${m.name.replace(/'/g,"\\'")}')">🔄 Reset device lock</div>`:''}
                ${canEdit?`<div class="action-item" onclick="resetPwd('${m.id}','${m.username}')">🔑 Reset password</div>`:''}
                ${canEdit&&!isSelf?`<div class="action-item" onclick="toggleActive('${m.id}',${m.active})">${m.active?'⏸ Deactivate':'▶ Activate'}</div>`:''}
                ${canDelete&&!isTheSuperadmin?`<div class="action-item action-item-danger" onclick="deleteMember('${m.id}','${m.name.replace(/'/g,"\\'")}')">🗑 Delete</div>`:''}
              </div>
            </div>` : '<span style="font-size:12px;color:var(--text3);">—</span>'}
          </td>
        </tr>`
      }).join('')}</tbody>
    </table></div>` : '<div class="empty">No members yet.</div>'
}

window.openAddMember = () => { document.getElementById('addMemberModal').style.display='flex' }
window.saveNewMember = async function() {
  const name = document.getElementById('am-name').value.trim()
  const user = document.getElementById('am-user').value.trim().toLowerCase()
  const pass = document.getElementById('am-pass').value
  const role = document.getElementById('am-role').value
  if (!name||!user||!pass) { toast('All fields required','error'); return }
  if (pass.length<6) { toast('Password must be 6+ characters','error'); return }
  const pwHash = await hashPassword(pass)
  const { error } = await supabase.from('members').insert({ name, username:user, password_hash:pwHash, role })
  if (error?.code==='23505') { toast('Username taken','error'); return }
  if (error) { toast('Error adding member','error'); return }
  toast(`${name} added ✓`,'success')
  closeM('addMemberModal')
  ;['am-name','am-user','am-pass'].forEach(id=>document.getElementById(id).value='')
  fillMembersTable()
}

window.resetDevice = async function(id, name) {
  if (!confirm(`Reset device lock for "${name}"?\n\nThey can log in from any device next time and their device will be re-registered.`)) return
  await supabase.from('members').update({ device_fingerprint:null, device_approved:false }).eq('id',id)
  await supabase.from('sessions').delete().eq('member_id',id)
  toast('Device lock reset ✓','success'); fillMembersTable()
}

window.resetPwd = async function(id, username) {
  const np = prompt(`New password for @${username}:`)
  if (!np?.trim()) return
  if (np.length<6) { toast('Min 6 characters','error'); return }
  const ph = await hashPassword(np)
  await supabase.from('members').update({ password_hash:ph }).eq('id',id)
  await supabase.from('sessions').delete().eq('member_id',id)
  toast('Password reset ✓','success')
}

window.toggleActive = async function(id, cur) {
  await supabase.from('members').update({ active:!cur }).eq('id',id)
  if (cur) await supabase.from('sessions').delete().eq('member_id',id)
  toast(cur?'Deactivated':'Activated','success'); fillMembersTable()
}

window.deleteMember = async function(id, name) {
  if (!confirm(`Permanently delete "${name}"?\n\nAll attendance records will also be deleted.\nThis cannot be undone.`)) return
  await supabase.from('attendance').delete().eq('member_id',id)
  await supabase.from('sessions').delete().eq('member_id',id)
  await supabase.from('members').delete().eq('id',id)
  toast(`${name} deleted`,'success'); fillMembersTable()
}

// ─── SETTINGS ────────────────────────────────────────────────
async function loadSettings() {
  const el = document.getElementById('view-settings')
  const { data: rows } = await supabase.from('settings').select('*')
    .in('key',['office_start_time','office_end_time','absent_after_hours'])
  const smap = {}
  for (const r of rows||[]) smap[r.key] = (typeof r.value==='string' ? r.value : JSON.stringify(r.value)).replace(/"/g,'')
  const start  = smap['office_start_time']  || '09:00'
  const end    = smap['office_end_time']    || '18:00'
  const aahrs  = smap['absent_after_hours'] || '2'

  el.innerHTML = `
    <div class="page-header"><div><div class="page-title">Settings</div><div class="page-sub">System configuration — changes apply immediately to all future check-ins</div></div></div>
    <div class="card">
      <div class="card-hdr"><span class="card-title">Office hours</span></div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px;margin-bottom:18px;">
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">Office start time</label>
            <input type="time" id="officeStartTime" value="${start}" />
            <div style="font-size:11.5px;color:var(--text3);margin-top:4px;">Check-ins after this = Late</div>
          </div>
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">Office end time</label>
            <input type="time" id="officeEndTime" value="${end}" />
            <div style="font-size:11.5px;color:var(--text3);margin-top:4px;">Expected check-out time</div>
          </div>
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">Auto-absent after (hours)</label>
            <input type="number" id="absentAfterHrs" value="${aahrs}" min="1" max="12" style="max-width:100px;" />
            <div style="font-size:11.5px;color:var(--text3);margin-top:4px;">Hours after start, no check-in = Absent</div>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="saveOfficeSettings()">Save office settings</button>
      </div>
    </div>
    <div class="card">
      <div class="card-hdr"><span class="card-title">Auto-absent rules</span></div>
      <div class="card-body">
        <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6;">
          When you open the dashboard, Haazri HQ automatically marks absent any member who has not checked in
          within <strong style="color:var(--text)">${aahrs} hours</strong> of the office start time (<strong style="color:var(--text)">${start}</strong>).
          This runs every time any admin loads the dashboard.
        </p>
        <button class="btn btn-ghost btn-sm" onclick="runAutoAbsent()">▶ Run auto-absent now</button>
      </div>
    </div>
    ${isSuperAdmin() ? `
    <div class="card">
      <div class="card-hdr"><span class="card-title">Admin account</span></div>
      <div class="card-body">
        <p style="font-size:13px;color:var(--text2);margin-bottom:14px;">Change the superadmin password. All sessions will be signed out.</p>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">New password</label>
            <input type="password" id="newAdminPass" placeholder="min 6 characters" style="max-width:220px;" />
          </div>
          <button class="btn btn-amber btn-sm" onclick="changeOwnPassword()">Change password</button>
        </div>
      </div>
    </div>` : ''}
  `
}

window.saveOfficeSettings = async function() {
  const start = document.getElementById('officeStartTime')?.value
  const end   = document.getElementById('officeEndTime')?.value
  const aah   = document.getElementById('absentAfterHrs')?.value
  if (!start) { toast('Start time required','error'); return }
  await Promise.all([
    supabase.from('settings').upsert({ key:'office_start_time',  value: JSON.stringify(start), updated_at: nowStr() }),
    supabase.from('settings').upsert({ key:'office_end_time',    value: JSON.stringify(end||'18:00'), updated_at: nowStr() }),
    supabase.from('settings').upsert({ key:'absent_after_hours', value: JSON.stringify(String(aah||'2')), updated_at: nowStr() }),
  ])
  officeStart      = start
  officeEnd        = end || '18:00'
  absentAfterHours = Number(aah) || 2
  toast('Office settings saved ✓','success')
}

// Auto-absent: mark members absent if past (officeStart + absentAfterHours) and no check-in today
window.runAutoAbsent = async function() {
  const today     = todayStr()
  const now       = new Date()
  const [oh, om]  = officeStart.split(':').map(Number)
  const cutoff    = new Date()
  cutoff.setHours(oh + absentAfterHours, om, 0, 0)
  if (now < cutoff) { toast('Cutoff time not reached yet — no action taken'); return }

  const { data: members } = await supabase.from('members').select('*').eq('active',true).not('role','in','("superadmin","admin")')
  const { data: existing } = await supabase.from('attendance').select('member_id').eq('date', today)
  const checkedInIds = new Set((existing||[]).map(a=>a.member_id))
  const toMark = (members||[]).filter(m => !checkedInIds.has(m.id))
  if (!toMark.length) { toast('No absent members to mark'); return }
  const rows = toMark.map(m => ({ member_id:m.id, member_name:m.name, date:today, status:'absent', marked_by:'auto' }))
  await supabase.from('attendance').upsert(rows, { onConflict:'member_id,date' })
  toast(`Marked ${toMark.length} member(s) absent ✓`,'success')
  if (adminView==='dashboard') loadDashboard()
}

window.changeOwnPassword = async function() {
  const np = document.getElementById('newAdminPass')?.value
  if (!np?.trim()||np.length<6) { toast('Min 6 characters','error'); return }
  const ph = await hashPassword(np)
  await supabase.from('members').update({ password_hash:ph }).eq('id',currentUser.id)
  await supabase.from('sessions').delete().eq('member_id',currentUser.id)
  toast('Password changed. Signing out…','success')
  setTimeout(doLogout, 1500)
}

// ─── ATTENDANCE EDIT / MANUAL ─────────────────────────────────
window.openEditAtt = async function(id) {
  document.querySelectorAll('.action-menu.open').forEach(m=>m.classList.remove('open'))
  const { data: r } = await supabase.from('attendance').select('*').eq('id',id).single()
  if (!r) return
  document.getElementById('ea-id').value   = r.id
  document.getElementById('ea-mem').value  = r.member_name
  document.getElementById('ea-date').value = r.date
  document.getElementById('ea-status').value = r.status
  document.getElementById('ea-cin').value  = r.check_in_time  ? new Date(r.check_in_time).toTimeString().slice(0,5)  : ''
  document.getElementById('ea-cout').value = r.check_out_time ? new Date(r.check_out_time).toTimeString().slice(0,5) : ''
  document.getElementById('ea-note').value = r.note||''
  document.getElementById('editAttModal').style.display='flex'
}
window.saveEditAtt = async function() {
  const id   = document.getElementById('ea-id').value
  const date = document.getElementById('ea-date').value
  const cin  = document.getElementById('ea-cin').value
  const cout = document.getElementById('ea-cout').value
  const upd  = {
    date, status: document.getElementById('ea-status').value,
    check_in_time:  cin  ? new Date(`${date}T${cin}`).toISOString()  : null,
    check_out_time: cout ? new Date(`${date}T${cout}`).toISOString() : null,
    note: document.getElementById('ea-note').value.trim()||null,
    marked_by:'admin'
  }
  await supabase.from('attendance').update(upd).eq('id',id)
  closeM('editAttModal'); toast('Record updated ✓','success')
  fillAttTable(document.getElementById('af-from')?.value||todayStr(), document.getElementById('af-to')?.value||todayStr(), document.getElementById('af-mem')?.value||'')
}

window.delAtt = async function(id) {
  document.querySelectorAll('.action-menu.open').forEach(m=>m.classList.remove('open'))
  if (!confirm('Delete this attendance record?')) return
  await supabase.from('attendance').delete().eq('id',id)
  toast('Deleted','success')
  fillAttTable(document.getElementById('af-from')?.value||todayStr(), document.getElementById('af-to')?.value||todayStr(), document.getElementById('af-mem')?.value||'')
}

window.openManualAtt = async function() {
  const { data: members } = await supabase.from('members').select('*').eq('active',true).neq('role','superadmin').neq('role','admin')
  const sel = document.getElementById('ma-mem')
  sel.innerHTML = (members||[]).map(m=>`<option value="${m.id}" data-name="${m.name}">${m.name}</option>`).join('')
  document.getElementById('ma-date').value = todayStr()
  document.getElementById('ma-cin').value  = ''
  document.getElementById('ma-note').value = ''
  document.getElementById('manualAttModal').style.display = 'flex'
}
window.saveManualAtt = async function() {
  const selEl = document.getElementById('ma-mem')
  const memId = selEl.value
  const memName = selEl.options[selEl.selectedIndex]?.dataset.name||''
  const date  = document.getElementById('ma-date').value
  const cin   = document.getElementById('ma-cin').value
  const status = document.getElementById('ma-status').value
  const note  = document.getElementById('ma-note').value.trim()||null
  if (!memId||!date) { toast('Member and date required','error'); return }
  const row = {
    member_id:memId, member_name:memName, date,
    check_in_time: cin ? new Date(`${date}T${cin}`).toISOString() : null,
    status, note, marked_by:'admin'
  }
  const { error } = await supabase.from('attendance').upsert(row, { onConflict:'member_id,date' })
  if (error) { toast('Error saving','error'); return }
  closeM('manualAttModal'); toast('Attendance marked ✓','success')
  if (adminView==='dashboard')  loadDashboard()
  if (adminView==='attendance') loadAttendance()
}

// ─── CSV EXPORTS ──────────────────────────────────────────────
window.exportAttCSV = async function() {
  const from = document.getElementById('af-from')?.value||todayStr()
  const to   = document.getElementById('af-to')?.value||todayStr()
  const mem  = document.getElementById('af-mem')?.value||''
  let q = supabase.from('attendance').select('*').gte('date',from).lte('date',to).order('date',{ascending:false})
  if (mem) q = q.eq('member_id',mem)
  const { data } = await q
  if (!data?.length) { toast('No data to export','error'); return }
  const headers = ['Date','Member','Status','Check-in','Check-out','Note','Marked By']
  const rows    = data.map(r=>[r.date,r.member_name,r.status,fmt12(r.check_in_time),fmt12(r.check_out_time),r.note||'',r.marked_by||''])
  dlCSV(`haazri_attendance_${from}_${to}.csv`, headers, rows)
  toast('CSV downloaded ✓','success')
}

window.exportPerfCSV = async function() {
  const from = document.getElementById('pf-from')?.value||todayStr()
  const to   = document.getElementById('pf-to')?.value||todayStr()
  const [{ data: members },{ data: att }] = await Promise.all([
    supabase.from('members').select('*').eq('active',true).neq('role','superadmin').neq('role','admin'),
    supabase.from('attendance').select('*').gte('date',from).lte('date',to)
  ])
  const d1=new Date(from),d2=new Date(to)
  const total=Math.max(1,Math.round((d2-d1)/86400000)+1)
  const headers=['Member','Present','Late','On Leave','Absent','Total Days','Attendance %']
  const rows=(members||[]).map(m=>{
    const ma=(att||[]).filter(a=>a.member_id===m.id)
    const p=ma.filter(a=>a.status==='present'||a.status==='on_time').length
    const l=ma.filter(a=>a.status==='late').length
    const o=ma.filter(a=>a.status==='on_leave').length
    const ab=ma.filter(a=>a.status==='absent').length
    return [m.name,p,l,o,ab,total,Math.round(((p+l)/total)*100)+'%']
  })
  dlCSV(`haazri_performance_${from}_${to}.csv`, headers, rows)
  toast('CSV downloaded ✓','success')
}

function dlCSV(fname, headers, rows) {
  const esc  = v => `"${String(v).replace(/"/g,'""')}"`
  const lines = [headers.map(esc).join(','), ...rows.map(r=>r.map(esc).join(','))]
  const blob  = new Blob([lines.join('\n')], { type:'text/csv;charset=utf-8;' })
  const url   = URL.createObjectURL(blob)
  const a     = document.createElement('a'); a.href=url; a.download=fname
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
}

// ─── Start ────────────────────────────────────────────────────
boot()
