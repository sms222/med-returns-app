import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

// Shown once, right after a staff member's first sign-in. They pick their
// home hospital and bin, and never have to touch this screen again —
// every bag they log afterward is tagged automatically.
export default function HomeSetup() {
  const { user, refreshProfile } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [idNumber, setIdNumber] = useState('')
  const [hospitals, setHospitals] = useState([])
  const [bins, setBins] = useState([])
  const [hospitalId, setHospitalId] = useState('')
  const [binId, setBinId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('hospitals').select('*').order('name').then(({ data }) => setHospitals(data ?? []))
  }, [])

  useEffect(() => {
    if (!hospitalId) return setBins([])
    supabase.from('bins').select('*').eq('hospital_id', hospitalId).order('code')
      .then(({ data }) => setBins(data ?? []))
  }, [hospitalId])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const { error } = await supabase.from('staff_profiles').insert({
      id: user.id,
      display_name: displayName,
      id_number: idNumber,
      hospital_id: hospitalId,
      bin_id: binId,
    })
    setBusy(false)
    if (error) return setError(error.message)
    refreshProfile()
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>One-time setup</h1>
        <p className="auth-sub">Pick your name, hospital and bin. You won't need to do this again.</p>
        <form onSubmit={handleSubmit}>
          <label>
            Your name
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} required autoFocus />
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
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
        </form>
      </div>
    </div>
  )
}
