import './style.css'
import { supabase }                      from './supabase.js'
import { getDeviceFingerprint, hashPassword } from './fingerprint.js'

// ─── State ────────────────────────────────────────────────────
let currentUser  = null
let currentToken = null
let deviceFP     = null
let officeStart = '09:00'
let officeEnd   = '18:00'
let lateTime    = '09:00'   // check-ins after this = late (settable separately)
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
  const { data: rows } = await supabase.from('settings').select('*').in('key',['office_start_time','office_end_time','late_time'])
  if (!rows) return
  for (const r of rows) {
    const v = typeof r.value === 'string' ? r.value.replace(/"/g,'') : r.value
    if (r.key === 'office_start_time') officeStart = v
    if (r.key === 'office_end_time')   officeEnd   = v
    if (r.key === 'late_time')         lateTime    = v
  }
}

function isLate(checkinTime) {
  if (!checkinTime) return false
  const [lh, lm] = lateTime.split(':').map(Number)
  const d = new Date(checkinTime)
  return d.getHours() > lh || (d.getHours() === lh && d.getMinutes() > lm)
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
let _clockRAF = null   // animation frame handle — cancel on navigation

function renderLogin() {
  if (_clockRAF) { cancelAnimationFrame(_clockRAF); _clockRAF = null }

  document.getElementById('app').innerHTML = `
  <div class="login-page">
    <div class="login-canvas-side" id="canvasSide">
      <canvas id="clockCanvas"></canvas>
      <div class="login-clock-brand">
        <div class="lcb-name">Haazri HQ</div>
        <div class="lcb-tag">Attendance System</div>
        <div class="lcb-live-time" id="lcbTime"></div>
      </div>
    </div>
    <div class="login-form-side">
      <div class="login-form-inner">
        <div class="login-form-logo">
          <div class="login-form-logo-icon">⏱</div>
          <div>
            <div class="login-form-logo-text">Haazri HQ</div>
            <div class="login-form-logo-sub">attendance</div>
          </div>
        </div>
        <div class="login-form-title">Welcome back</div>
        <div class="login-form-sub">Sign in to your account.</div>
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
        <div class="login-note">First sign-in locks your account to this device.<br>Future logins from other devices will be blocked.</div>
      </div>
    </div>
  </div>`

  // Kick off the canvas clock after DOM is ready
  requestAnimationFrame(initClockCanvas)
}

function initClockCanvas() {
  const canvas = document.getElementById('clockCanvas')
  if (!canvas) return
  const container = document.getElementById('canvasSide')
  const ctx = canvas.getContext('2d')

  function resize() {
    canvas.width  = container.offsetWidth
    canvas.height = container.offsetHeight
  }
  resize()
  window.addEventListener('resize', resize)

  // ── Concentric ring definitions ─────────────────────────────
  // Each ring: radius fraction, speed (rad/s), tick count, opacity, color, width, direction
  const rings = [
    { r: 0.42, speed: 0.004,  ticks: 60, opacity: 0.08, color: '#00d4aa', lw: 0.5, dir: 1  },
    { r: 0.38, speed: 0.012,  ticks: 12, opacity: 0.18, color: '#00d4aa', lw: 1.0, dir: -1 },
    { r: 0.32, speed: 0.022,  ticks: 60, opacity: 0.10, color: '#f5a623', lw: 0.5, dir: 1  },
    { r: 0.25, speed: 0.040,  ticks: 12, opacity: 0.22, color: '#f5a623', lw: 1.2, dir: -1 },
    { r: 0.17, speed: 0.080,  ticks: 60, opacity: 0.08, color: '#00d4aa', lw: 0.5, dir: 1  },
    { r: 0.10, speed: 0.200,  ticks:  4, opacity: 0.28, color: '#00d4aa', lw: 1.5, dir: -1 },
  ]
  // Arc progress bands — decorative arcs that sweep around rings
  const bands = [
    { r: 0.38, speed: 0.018, phase: 0,    arc: 0.55, color: '#00d4aa', lw: 2.5, dir:  1 },
    { r: 0.25, speed: 0.045, phase: 2.1,  arc: 0.35, color: '#f5a623', lw: 2.0, dir: -1 },
    { r: 0.17, speed: 0.090, phase: 4.3,  arc: 0.20, color: '#00d4aa', lw: 1.5, dir:  1 },
  ]
  // Glowing dots orbiting
  const dots = [
    { r: 0.38, speed: 0.018, phase: 0,   size: 4, color: '#00d4aa', glow: 'rgba(0,212,170,0.6)'  },
    { r: 0.38, speed: 0.018, phase: Math.PI, size: 3, color: '#00d4aa', glow: 'rgba(0,212,170,0.4)' },
    { r: 0.25, speed: 0.045, phase: 1.2, size: 5, color: '#f5a623', glow: 'rgba(245,166,35,0.6)' },
    { r: 0.25, speed: 0.045, phase: 3.8, size: 3, color: '#f5a623', glow: 'rgba(245,166,35,0.4)' },
    { r: 0.17, speed: 0.090, phase: 2.5, size: 3, color: '#fff',    glow: 'rgba(255,255,255,0.3)' },
    { r: 0.10, speed: 0.200, phase: 0,   size: 4, color: '#00d4aa', glow: 'rgba(0,212,170,0.8)'  },
  ]
  // Center hub spokes
  const spokeCount = 12

  let t = 0
  let prevTime = null

  function draw(timestamp) {
    if (!document.getElementById('clockCanvas')) return  // navigated away

    const dt = prevTime ? Math.min((timestamp - prevTime) / 1000, 0.05) : 0.016
    prevTime = timestamp
    t += dt

    const W = canvas.width
    const H = canvas.height
    const cx = W / 2
    const cy = H / 2
    const minDim = Math.min(W, H)

    ctx.clearRect(0, 0, W, H)

    // ── Background radial vignette ──────────────────────────────
    const vign = ctx.createRadialGradient(cx, cy, 0, cx, cy, minDim * 0.6)
    vign.addColorStop(0, 'rgba(0,40,32,0.25)')
    vign.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = vign; ctx.fillRect(0, 0, W, H)

    // ── Concentric rings with tick marks ───────────────────────
    rings.forEach(ring => {
      const rad  = minDim * ring.r
      const angle = ring.dir * ring.speed * t * 60  // angle offset over time

      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(angle)

      // Ring circle
      ctx.beginPath()
      ctx.arc(0, 0, rad, 0, Math.PI * 2)
      ctx.strokeStyle = ring.color
      ctx.globalAlpha = ring.opacity
      ctx.lineWidth   = ring.lw
      ctx.stroke()

      // Tick marks
      for (let i = 0; i < ring.ticks; i++) {
        const a     = (i / ring.ticks) * Math.PI * 2
        const isMaj = i % (ring.ticks / 4) === 0
        const len   = isMaj ? 10 : 5
        const x1    = Math.cos(a) * (rad - len / 2)
        const y1    = Math.sin(a) * (rad - len / 2)
        const x2    = Math.cos(a) * (rad + len / 2)
        const y2    = Math.sin(a) * (rad + len / 2)
        ctx.beginPath()
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
        ctx.globalAlpha = isMaj ? ring.opacity * 3 : ring.opacity * 1.5
        ctx.lineWidth   = isMaj ? ring.lw * 1.5 : ring.lw
        ctx.stroke()
      }
      ctx.restore()
    })

    // ── Sweep arcs (progress band style) ───────────────────────
    ctx.globalAlpha = 1
    bands.forEach(band => {
      const rad    = minDim * band.r
      const startA = band.dir * band.speed * t * 60 + band.phase
      const endA   = startA + Math.PI * 2 * band.arc

      ctx.save()
      ctx.translate(cx, cy)
      ctx.beginPath()
      ctx.arc(0, 0, rad, startA, endA)
      ctx.strokeStyle = band.color
      ctx.lineWidth   = band.lw
      ctx.globalAlpha = 0.55
      ctx.lineCap     = 'round'
      ctx.stroke()
      ctx.restore()
    })

    // ── Orbiting glowing dots ───────────────────────────────────
    ctx.globalAlpha = 1
    dots.forEach(dot => {
      const rad = minDim * dot.r
      const a   = dot.speed * t * 60 + dot.phase
      const dx  = cx + Math.cos(a) * rad
      const dy  = cy + Math.sin(a) * rad

      // Glow halo
      const gr = ctx.createRadialGradient(dx, dy, 0, dx, dy, dot.size * 4)
      gr.addColorStop(0, dot.glow)
      gr.addColorStop(1, 'transparent')
      ctx.beginPath()
      ctx.arc(dx, dy, dot.size * 4, 0, Math.PI * 2)
      ctx.fillStyle = gr
      ctx.fill()

      // Core dot
      ctx.beginPath()
      ctx.arc(dx, dy, dot.size * 0.7, 0, Math.PI * 2)
      ctx.fillStyle = dot.color
      ctx.fill()
    })

    // ── Center hub ──────────────────────────────────────────────
    const hubR = minDim * 0.06
    // Spokes
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(t * 0.3)
    for (let i = 0; i < spokeCount; i++) {
      const a = (i / spokeCount) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(a) * hubR, Math.sin(a) * hubR)
      ctx.strokeStyle = '#00d4aa'
      ctx.globalAlpha = 0.12
      ctx.lineWidth   = 0.8
      ctx.stroke()
    }
    // Hub glow
    const hubGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, hubR)
    hubGlow.addColorStop(0, 'rgba(0,212,170,0.35)')
    hubGlow.addColorStop(1, 'transparent')
    ctx.beginPath(); ctx.arc(0, 0, hubR, 0, Math.PI * 2)
    ctx.fillStyle = hubGlow; ctx.globalAlpha = 1; ctx.fill()
    // Hub dot
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2)
    ctx.fillStyle = '#00d4aa'; ctx.fill()
    ctx.restore()

    // ── Live time overlay (big faint numbers) ───────────────────
    const timeEl = document.getElementById('lcbTime')
    if (timeEl) {
      const now = new Date()
      timeEl.textContent = now.toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' })
    }

    _clockRAF = requestAnimationFrame(draw)
  }

  _clockRAF = requestAnimationFrame(draw)
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
  if (_clockRAF)    { cancelAnimationFrame(_clockRAF); _clockRAF = null }
  if (_memberRingRAF) { cancelAnimationFrame(_memberRingRAF); _memberRingRAF = null }
  if (isAdmin()) renderAdmin()
  else            renderMemberPage()
}

window.doLogout = async function() {
  if (_memberRingRAF) { cancelAnimationFrame(_memberRingRAF); _memberRingRAF = null }
  if (currentToken) await supabase.from('sessions').delete().eq('token', currentToken)
  localStorage.removeItem('hq_token')
  currentUser = currentToken = null
  renderLogin()
}

// ─── MEMBER CHECK-IN / CHECK-OUT PAGE ─────────────────────────
let _memberRingRAF = null   // bg ring animation handle
let _ringsFrozen    = false  // true after check-in

async function renderMemberPage() {
  if (_memberRingRAF) { cancelAnimationFrame(_memberRingRAF); _memberRingRAF = null }
  _ringsFrozen = false

  const today = todayStr()
  const { data: record } = await supabase.from('attendance')
    .select('*').eq('member_id', currentUser.id).eq('date', today).single()

  document.getElementById('app').innerHTML = `
  <div class="checkin-page" style="position:relative;overflow:hidden;">
    <canvas id="memberBgCanvas" style="position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;"></canvas>
    <div class="checkin-card" style="position:relative;z-index:2;">
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
        <div class="clock-office">Start: <strong>${officeStart}</strong>&ensp;·&ensp;Late after: <strong>${lateTime}</strong></div>
      </div>

      <div id="attendanceContent"></div>
    </div>
  </div>`

  setInterval(tickClock, 1000); tickClock()
  startMemberBgRings()
  renderAttendanceContent(record)
}

function startMemberBgRings() {
  const canvas = document.getElementById('memberBgCanvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')

  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
  resize()
  window.addEventListener('resize', resize)

  // Same ring definitions as login page but slightly dimmer / adapted
  const rings = [
    { r:0.42, speed:0.004,  ticks:60, opacity:0.05, color:'#00d4aa', lw:0.5, dir: 1 },
    { r:0.36, speed:0.012,  ticks:12, opacity:0.10, color:'#00d4aa', lw:1.0, dir:-1 },
    { r:0.28, speed:0.022,  ticks:60, opacity:0.06, color:'#f5a623', lw:0.5, dir: 1 },
    { r:0.20, speed:0.040,  ticks:12, opacity:0.12, color:'#f5a623', lw:1.2, dir:-1 },
    { r:0.13, speed:0.080,  ticks:60, opacity:0.05, color:'#00d4aa', lw:0.5, dir: 1 },
    { r:0.07, speed:0.200,  ticks: 4, opacity:0.14, color:'#00d4aa', lw:1.5, dir:-1 },
  ]
  const bands = [
    { r:0.36, speed:0.018, phase:0,   arc:0.55, color:'#00d4aa', lw:2.0, dir: 1 },
    { r:0.20, speed:0.045, phase:2.1, arc:0.35, color:'#f5a623', lw:1.5, dir:-1 },
  ]
  const dots = [
    { r:0.36, speed:0.018, phase:0,         size:3.5, color:'#00d4aa', glow:'rgba(0,212,170,0.5)' },
    { r:0.36, speed:0.018, phase:Math.PI,   size:2.5, color:'#00d4aa', glow:'rgba(0,212,170,0.3)' },
    { r:0.20, speed:0.045, phase:1.2,       size:4,   color:'#f5a623', glow:'rgba(245,166,35,0.5)' },
    { r:0.07, speed:0.200, phase:0,         size:3,   color:'#00d4aa', glow:'rgba(0,212,170,0.7)' },
  ]

  let t = 0, frozenT = 0, prevTime = null

  function draw(timestamp) {
    if (!document.getElementById('memberBgCanvas')) return
    const dt = prevTime ? Math.min((timestamp - prevTime) / 1000, 0.05) : 0.016
    prevTime = timestamp

    // When frozen, t stops advancing — rings are locked in place
    if (!_ringsFrozen) { t += dt } else { frozenT += dt }

    const W = canvas.width, H = canvas.height
    const cx = W / 2, cy = H / 2
    const minDim = Math.min(W, H)

    ctx.clearRect(0, 0, W, H)

    // Rings
    rings.forEach(ring => {
      const rad   = minDim * ring.r
      const angle = ring.dir * ring.speed * t * 60

      ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle)
      ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2)
      ctx.strokeStyle = ring.color; ctx.globalAlpha = ring.opacity
      ctx.lineWidth = ring.lw; ctx.stroke()

      for (let i = 0; i < ring.ticks; i++) {
        const a = (i / ring.ticks) * Math.PI * 2
        const isMaj = i % (ring.ticks / 4) === 0
        const len = isMaj ? 8 : 4
        ctx.beginPath()
        ctx.moveTo(Math.cos(a)*(rad-len/2), Math.sin(a)*(rad-len/2))
        ctx.lineTo(Math.cos(a)*(rad+len/2), Math.sin(a)*(rad+len/2))
        ctx.globalAlpha = isMaj ? ring.opacity*3 : ring.opacity*1.5
        ctx.lineWidth = isMaj ? ring.lw*1.5 : ring.lw
        ctx.stroke()
      }
      ctx.restore()
    })

    // Sweep bands
    ctx.globalAlpha = 1
    bands.forEach(band => {
      const rad = minDim * band.r
      const startA = band.dir * band.speed * t * 60 + band.phase
      ctx.save(); ctx.translate(cx, cy)
      ctx.beginPath(); ctx.arc(0, 0, rad, startA, startA + Math.PI * 2 * band.arc)
      ctx.strokeStyle = band.color; ctx.lineWidth = band.lw
      ctx.globalAlpha = 0.35; ctx.lineCap = 'round'; ctx.stroke()
      ctx.restore()
    })

    // Orbiting dots
    ctx.globalAlpha = 1
    dots.forEach(dot => {
      const rad = minDim * dot.r
      const a = dot.speed * t * 60 + dot.phase
      const dx = cx + Math.cos(a) * rad, dy = cy + Math.sin(a) * rad
      const gr = ctx.createRadialGradient(dx, dy, 0, dx, dy, dot.size * 3)
      gr.addColorStop(0, dot.glow); gr.addColorStop(1, 'transparent')
      ctx.beginPath(); ctx.arc(dx, dy, dot.size * 3, 0, Math.PI * 2)
      ctx.fillStyle = gr; ctx.fill()
      ctx.beginPath(); ctx.arc(dx, dy, dot.size * 0.6, 0, Math.PI * 2)
      ctx.fillStyle = dot.color; ctx.fill()
    })

    // Center hub
    const hubR = minDim * 0.04
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 0.3)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      ctx.beginPath(); ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(a)*hubR, Math.sin(a)*hubR)
      ctx.strokeStyle = '#00d4aa'; ctx.globalAlpha = 0.08
      ctx.lineWidth = 0.8; ctx.stroke()
    }
    const hg = ctx.createRadialGradient(0,0,0,0,0,hubR)
    hg.addColorStop(0,'rgba(0,212,170,0.20)'); hg.addColorStop(1,'transparent')
    ctx.beginPath(); ctx.arc(0,0,hubR,0,Math.PI*2)
    ctx.fillStyle = hg; ctx.globalAlpha = 1; ctx.fill()
    ctx.beginPath(); ctx.arc(0,0,2.5,0,Math.PI*2)
    ctx.fillStyle = '#00d4aa'; ctx.fill()
    ctx.restore()

    _memberRingRAF = requestAnimationFrame(draw)
  }

  _memberRingRAF = requestAnimationFrame(draw)
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
      on_time: { cls:'sr-present', icon:'🟢', label:'Present · On time', color:'var(--green)', anim:'glory' },
      present: { cls:'sr-present', icon:'✅', label:'Present',            color:'var(--green)', anim:'glory' },
      late:    { cls:'sr-late',    icon:'🕐', label:'Present · Late',     color:'var(--amber)', anim:'late'  },
      absent:  { cls:'sr-absent',  icon:'❌', label:'Absent',             color:'var(--red)',   anim:'none'  },
      on_leave:{ cls:'sr-leave',   icon:'🏖', label:'On Leave',           color:'var(--blue)',  anim:'none'  },
    }
    const sc = statusConf[record.status] || statusConf.present
    const checkedOut = !!record.check_out_time
    el.innerHTML = `
      <div class="status-result ${sc.cls}" id="statusCard">
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
    // Freeze rings and play mood flash
    requestAnimationFrame(() => {
      _ringsFrozen = true
      if (sc.anim === 'glory') playGloryMood()
      if (sc.anim === 'late')  playLateMood()
    })
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
// Auto-absent is now manual only — admin presses the button in Settings
async function _silentAutoAbsent() { /* no-op */ }

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
    .in('key',['office_start_time','office_end_time','late_time'])
  const smap = {}
  for (const r of rows||[]) smap[r.key] = (typeof r.value==='string' ? r.value : JSON.stringify(r.value)).replace(/"/g,'')
  const startV = smap['office_start_time'] || '09:00'
  const endV   = smap['office_end_time']   || '18:00'
  const lateV  = smap['late_time']         || '09:00'
  el.innerHTML = `
    <div class="page-header"><div><div class="page-title">Settings</div><div class="page-sub">Changes apply immediately to all future check-ins</div></div></div>
    <div class="card">
      <div class="card-hdr"><span class="card-title">Office hours</span></div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px;margin-bottom:20px;">
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">Office start time</label>
            <input type="time" id="officeStartTime" value="${startV}" />
            <div style="font-size:11.5px;color:var(--text3);margin-top:4px;">Official start of the workday</div>
          </div>
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">Late threshold</label>
            <input type="time" id="lateTimeInput" value="${lateV}" />
            <div style="font-size:11.5px;color:var(--text3);margin-top:4px;">Check-ins after this time = Late</div>
          </div>
          <div class="fg" style="margin-bottom:0;">
            <label class="field-label">Office end time</label>
            <input type="time" id="officeEndTime" value="${endV}" />
            <div style="font-size:11.5px;color:var(--text3);margin-top:4px;">Expected check-out time</div>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="saveOfficeSettings()">Save office settings</button>
      </div>
    </div>
    <div class="card">
      <div class="card-hdr"><span class="card-title">Mark all absent</span></div>
      <div class="card-body">
        <p style="font-size:13px;color:var(--text2);margin-bottom:14px;line-height:1.6;">
          Press this button to immediately mark every member who has <strong style="color:var(--text);">not checked in today</strong> as <strong style="color:var(--red);">Absent</strong>.
          Use this at end of day when the workday is clearly over.
        </p>
        <button class="btn btn-danger btn-sm" onclick="runMarkAllAbsent()">❌ Mark all absent now</button>
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
  const late  = document.getElementById('lateTimeInput')?.value
  if (!start) { toast('Start time required','error'); return }
  await Promise.all([
    supabase.from('settings').upsert({ key:'office_start_time', value: JSON.stringify(start), updated_at: nowStr() }),
    supabase.from('settings').upsert({ key:'office_end_time',   value: JSON.stringify(end||'18:00'), updated_at: nowStr() }),
    supabase.from('settings').upsert({ key:'late_time',         value: JSON.stringify(late||start), updated_at: nowStr() }),
  ])
  officeStart = start; officeEnd = end||'18:00'; lateTime = late||start
  toast('Office settings saved ✓','success')
}

window.runMarkAllAbsent = async function() {
  if (!confirm('Mark ALL members who have not checked in today as Absent?\n\nThis cannot be undone.')) return
  const today = todayStr()
  const { data: members }  = await supabase.from('members').select('id,name').eq('active',true).not('role','in','("superadmin","admin")')
  const { data: existing } = await supabase.from('attendance').select('member_id').eq('date', today)
  const checkedInIds = new Set((existing||[]).map(a=>a.member_id))
  const toMark = (members||[]).filter(m => !checkedInIds.has(m.id))
  if (!toMark.length) { toast('All members already marked today ✓','success'); return }
  const rows = toMark.map(m => ({ member_id:m.id, member_name:m.name, date:today, status:'absent', marked_by:'admin' }))
  await supabase.from('attendance').upsert(rows, { onConflict:'member_id,date' })
  toast(`${toMark.length} member(s) marked absent ✓`,'success')
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


// ── Glory mood — rings freeze, golden flash + card glow ─────────
function playGloryMood() {
  // Golden background pulse — overlay canvas
  const overlay = document.createElement('canvas')
  overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;'
  overlay.width  = window.innerWidth
  overlay.height = window.innerHeight
  document.body.appendChild(overlay)
  const ctx = overlay.getContext('2d')

  // Ring burst — 4 concentric golden rings expanding outward from center
  const CX = overlay.width / 2, CY = overlay.height / 2
  const burstRings = [
    { r: 0,    maxR: Math.min(CX, CY) * 0.55, delay: 0   },
    { r: 0,    maxR: Math.min(CX, CY) * 0.75, delay: 6   },
    { r: 0,    maxR: Math.min(CX, CY) * 0.95, delay: 12  },
    { r: 0,    maxR: Math.min(CX, CY) * 1.20, delay: 18  },
  ]

  let frame = 0
  const totalFrames = 80

  function tick() {
    if (!overlay.parentNode) return
    ctx.clearRect(0, 0, overlay.width, overlay.height)

    // Background golden tint — peaks at frame 12, fades out
    const bgAlpha = frame < 12
      ? (frame / 12) * 0.18
      : Math.max(0, 0.18 - ((frame - 12) / 50) * 0.18)
    ctx.fillStyle = `rgba(255, 210, 50, ${bgAlpha})`
    ctx.fillRect(0, 0, overlay.width, overlay.height)

    // Expanding rings — golden
    for (const ring of burstRings) {
      const f = frame - ring.delay
      if (f < 0) continue
      ring.r = Math.min(ring.maxR, f * (ring.maxR / 45))
      const progress = ring.r / ring.maxR
      const alpha = Math.max(0, (1 - progress) * 0.7)
      ctx.beginPath()
      ctx.arc(CX, CY, ring.r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 210, 50, ${alpha})`
      ctx.lineWidth = 2.5 * (1 - progress * 0.7)
      ctx.stroke()
    }

    // Status card glow — golden border shimmer
    const card = document.getElementById('statusCard')
    if (card) {
      const glowStrength = frame < 20
        ? (frame / 20)
        : Math.max(0, 1 - (frame - 20) / 45)
      const gs = Math.round(glowStrength * 32)
      card.style.boxShadow = gs > 1
        ? `0 0 ${gs}px rgba(255,210,50,${glowStrength * 0.6}), 0 0 ${gs*2}px rgba(255,180,0,${glowStrength * 0.25})`
        : ''
      card.style.borderColor = glowStrength > 0.1
        ? `rgba(255,210,50,${glowStrength * 0.8})`
        : ''
    }

    frame++
    if (frame < totalFrames) requestAnimationFrame(tick)
    else {
      overlay.remove()
      if (card) { card.style.boxShadow = ''; card.style.borderColor = '' }
    }
  }

  requestAnimationFrame(tick)
}

// ── Late mood — rings freeze, dark red flash + card red glow ─────
function playLateMood() {
  const overlay = document.createElement('canvas')
  overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;'
  overlay.width  = window.innerWidth
  overlay.height = window.innerHeight
  document.body.appendChild(overlay)
  const ctx = overlay.getContext('2d')

  const CX = overlay.width / 2, CY = overlay.height / 2

  // Contracting rings — deep red closing inward (opposite of glory)
  const contractRings = [
    { r: Math.min(CX,CY)*1.20, minR: 0, delay: 0  },
    { r: Math.min(CX,CY)*0.95, minR: 0, delay: 5  },
    { r: Math.min(CX,CY)*0.70, minR: 0, delay: 10 },
  ]

  let frame = 0
  const totalFrames = 75

  function tick() {
    if (!overlay.parentNode) return
    ctx.clearRect(0, 0, overlay.width, overlay.height)

    // Dark red background tint — slightly slower fade
    const bgAlpha = frame < 15
      ? (frame / 15) * 0.20
      : Math.max(0, 0.20 - ((frame - 15) / 48) * 0.20)
    ctx.fillStyle = `rgba(180, 20, 20, ${bgAlpha})`
    ctx.fillRect(0, 0, overlay.width, overlay.height)

    // Contracting rings — closing inward
    for (const ring of contractRings) {
      const f = frame - ring.delay
      if (f < 0) continue
      const progress = Math.min(1, f / 50)
      const currentR = ring.r * (1 - progress)
      if (currentR < 2) continue
      const alpha = Math.max(0, (1 - progress) * 0.65)
      ctx.beginPath()
      ctx.arc(CX, CY, currentR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(220, 50, 50, ${alpha})`
      ctx.lineWidth = 2.0 * (1 - progress * 0.5)
      ctx.stroke()
    }

    // Status card red glow
    const card = document.getElementById('statusCard')
    if (card) {
      const glowStrength = frame < 18
        ? (frame / 18)
        : Math.max(0, 1 - (frame - 18) / 42)
      const gs = Math.round(glowStrength * 28)
      card.style.boxShadow = gs > 1
        ? `0 0 ${gs}px rgba(220,50,50,${glowStrength * 0.5}), 0 0 ${gs*2}px rgba(180,20,20,${glowStrength * 0.22})`
        : ''
      card.style.borderColor = glowStrength > 0.1
        ? `rgba(220,50,50,${glowStrength * 0.7})`
        : ''
    }

    frame++
    if (frame < totalFrames) requestAnimationFrame(tick)
    else {
      overlay.remove()
      if (card) { card.style.boxShadow = ''; card.style.borderColor = '' }
    }
  }

  requestAnimationFrame(tick)
}

// ─── Start ────────────────────────────────────────────────────
boot()
