import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  document.getElementById('app').innerHTML = `
    <div style="font-family:sans-serif;padding:40px;max-width:500px;margin:0 auto;">
      <h2 style="color:#e44;">⚠ Missing environment variables</h2>
      <p style="margin-top:12px;">Create a <code>.env</code> file with:</p>
      <pre style="background:#f4f4f4;padding:12px;border-radius:6px;margin-top:8px;">
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_anon_key</pre>
    </div>`
  throw new Error('Missing env vars')
}

export const supabase = createClient(url, key)
