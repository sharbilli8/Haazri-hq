// ─── Device Identity ──────────────────────────────────────────
//
// Strategy: use localStorage as the primary device ID.
// On first login from a device, we generate a random UUID and store
// it in localStorage. That UUID becomes the device fingerprint.
// It never changes unless the user deliberately clears their browser data.
//
// Why not use browser signals (userAgent, screen, canvas)?
//   - userAgent changes on every browser update (Chrome auto-updates silently)
//   - screen dimensions change when monitors are connected/disconnected
//   - timezoneOffset changes on DST switches twice a year
//   - canvas output changes after GPU/OS/browser updates
//   All of these cause false "wrong device" errors within days or weeks.
//
// The localStorage UUID approach:
//   - Stable forever on the same browser+device
//   - Changes only if the user clears browser storage (very rare, intentional)
//   - Still prevents casual buddy-punching (someone else's phone won't have the UUID)
//   - Admin can reset it from the Members tab if genuinely needed

const DEVICE_ID_KEY = 'haazri_device_id'

export async function getDeviceFingerprint() {
  // Return existing stored ID if present
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (id && id.length >= 32) return id

  // Generate a new stable random ID for this device
  id = generateDeviceId()
  localStorage.setItem(DEVICE_ID_KEY, id)
  return id
}

function generateDeviceId() {
  // 48 hex chars — enough entropy to be unique
  const arr = new Uint8Array(24)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hashString(str) {
  const data = new TextEncoder().encode(str)
  const buf  = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 32)
}

export async function hashPassword(password) {
  return await hashString(password + 'freelancehq_salt_2024')
}
