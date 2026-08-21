import { useState } from 'react'
import { supabase } from '../lib/supabase'

const SUPPORT_EMAIL = 'shamin@ukm.edu.my'

export default function Login() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup' | 'reset'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

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

    const { error } = mode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password })
    setBusy(false)
    if (error) setError(error.message)
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
