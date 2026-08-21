import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const fn = mode === 'signin' ? supabase.auth.signInWithPassword : supabase.auth.signUp
    const { error } = await fn({ email, password })
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
          <label>
            Password
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <button className="link-btn" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
          {mode === 'signin' ? "New here? Create an account" : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  )
}
