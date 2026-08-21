import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

const SUPPORT_EMAIL = 'shamin@ukm.edu.my'

export default function Login() {
  const { refreshProfile } = useAuth()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'reset'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [idNumber, setIdNumber] = useState('')
  const [hospitals, setHospitals] = useState([])
  const [bins, setBins] = useState([])
  const [hospitalId, setHospitalId] = useState('')
  const [binId, setBinId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (mode !== 'signup') return
    supabase.from('hospitals').select('*').order('name').then(({ data }) => setHospitals(data ?? []))
  }, [mode])

  useEffect(() => {
    if (!hospitalId) return setBins([])
    supabase.from('bins').select('*').eq('hospital_id', hospitalId).order('code')
      .then(({ data }) => setBins(data ?? []))
  }, [hospitalId])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)

    if (mode === 'reset') {
      const { error } = await supabase.auth.resetPasswordForEmail(email)
      setBusy(false)
      if (error) return setError(error.message)
      return setNotice('If that email has an account, a reset link is on its way. Check your inbox (and spam folder).')
    }

    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      setBusy(false)
      if (error) setError(error.message)
      return
    }

    // mode === 'signup'
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setBusy(false)
      return setError(error.message)
    }

    if (data.session) {
      // Signed in immediately (email confirmation off) — finish setup now.
      const { error: profileError } = await supabase.from('staff_profiles').insert({
        id: data.user.id,
        display_name: displayName,
        id_number: idNumber,
        hospital_id: hospitalId,
        bin_id: binId,
      })
      setBusy(false)
      if (profileError) setError(profileError.message)
      else refreshProfile()
    } else {
      setBusy(false)
      setNotice('Check your email to confirm your account, then sign in — you\'ll finish setup on your first sign-in.')
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Med Returns</h1>
        <p className="auth-sub">Sign in to log and view returned medications.</p>
        <form onSubmit={handleSubmit}>
          <label>
            Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
          </label>
          {mode !== 'reset' && (
            <label>
              Password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            </label>
          )}

          {mode === 'signup' && (
            <>
              <label>
                Your name
                <input value={displayName} onChange={e => setDisplayName(e.target.value)} required />
              </label>
              <label>
                Staff / ID number
                <input value={idNumber} onChange={e => setIdNumber(e.target.value)} required />
              </label>
              <label>
                Hospital
                <select value={hospitalId} onChange={e => { setHospitalId(e.target.value); setBinId('') }} required>
                  <option value="" disabled>Choose hospital…</option>
                  {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </label>
              <label>
                Bin
                <select value={binId} onChange={e => setBinId(e.target.value)} required disabled={!hospitalId}>
                  <option value="" disabled>Choose bin…</option>
                  {bins.map(b => <option key={b.id} value={b.id}>{b.code} — {b.location_label}</option>)}
                </select>
              </label>
            </>
          )}

          {error && <p className="auth-error">{error}</p>}
          {notice && <p className="auth-notice">{notice}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </button>
        </form>

        {mode !== 'reset' && (
          <button className="link-btn" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setNotice('') }}>
            {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
          </button>
        )}
        {mode === 'signin' && (
          <button className="link-btn" onClick={() => { setMode('reset'); setError(''); setNotice('') }}>
            Forgot password?
          </button>
        )}
        {mode === 'reset' && (
          <button className="link-btn" onClick={() => { setMode('signin'); setError(''); setNotice('') }}>
            ← Back to sign in
          </button>
        )}

        <p className="auth-support">
          Having trouble? Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </div>
    </div>
  )
}
