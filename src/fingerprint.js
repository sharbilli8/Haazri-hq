// Generates a stable device fingerprint from browser characteristics.
// Not 100% unbreakable but sufficient to prevent casual check-in spoofing.
export async function getDeviceFingerprint() {
  const nav = window.navigator
  const screen = window.screen
  const parts = [
    nav.userAgent,
    nav.language,
    nav.platform,
    screen.colorDepth,
    screen.width + 'x' + screen.height,
    new Date().getTimezoneOffset(),
    nav.hardwareConcurrency || '',
    nav.deviceMemory || '',
    // Canvas fingerprint
    await canvasFingerprint(),
  ]
  const raw = parts.join('|')
  return await hashString(raw)
}

async function canvasFingerprint() {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 200; canvas.height = 50
    const ctx = canvas.getContext('2d')
    ctx.textBaseline = 'top'
    ctx.font = '14px Arial'
    ctx.fillStyle = '#f60'
    ctx.fillRect(125, 1, 62, 20)
    ctx.fillStyle = '#069'
    ctx.fillText('FreelanceHQ 🕐', 2, 15)
    ctx.fillStyle = 'rgba(102,204,0,0.7)'
    ctx.fillText('FreelanceHQ 🕐', 4, 17)
    return canvas.toDataURL().slice(-50)
  } catch { return 'no-canvas' }
}

async function hashString(str) {
  const encoder = new TextEncoder()
  const data = encoder.encode(str)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

// Simple password hashing using SHA-256 (not bcrypt — we handle auth server-side via Supabase)
export async function hashPassword(password) {
  return await hashString(password + 'freelancehq_salt_2024')
}
