import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

function formatMed(m) {
  const parts = []
  if (m.drug_name) parts.push(m.drug_name)
  if (m.brand_name) parts.push(`(${m.brand_name})`)
  const head = parts.join(' ') || 'Unnamed item'

  const details = []
  if (m.pack_type) details.push(m.pack_type)
  if (m.quantity_remaining != null && m.quantity_remaining !== '') details.push(`qty ${m.quantity_remaining}`)
  if (m.patient_mrn) details.push(`MRN ${m.patient_mrn}`)
  if (m.patient_name) details.push(m.patient_name)
  if (m.expiry_date) {
    const isExpired = new Date(m.expiry_date) < new Date()
    details.push(`exp ${m.expiry_date}${isExpired ? ' (expired)' : ''}`)
  }
  if (m.condition_flag && m.condition_flag !== 'ok') details.push(m.condition_flag)
  if (m.label_attached === false) details.push('no label')
  if (m.sealed === false) details.push('unsealed')
  if (m.disposition) details.push(m.disposition)
  if (m.source_clinic) details.push(`from ${m.source_clinic}`)
  if (m.notes) details.push(m.notes)

  return { head, details: details.join(' · ') }
}

function bagRef(bag) {
  const code = bag.bins?.code ?? '?'
  const num = bag.bag_number != null ? String(bag.bag_number).padStart(3, '0') : '???'
  return `${code}-${num}`
}

export default function BagList({ onOpenBag, refreshKey }) {
  const { profile } = useAuth()
  const [bags, setBags] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('submitted') // 'in_progress' | 'submitted' | 'deleted' | 'all'
  const [busyId, setBusyId] = useState(null)
  const [localRefresh, setLocalRefresh] = useState(0)
  const [deletedByNames, setDeletedByNames] = useState({})

  useEffect(() => {
    setLoading(true)
    setError('')
    let query = supabase
      .from('bags')
      .select('*, hospitals(name), bins(code, location_label), staff_profiles!bags_collected_by_fkey(display_name), medications(*)')
      .order('collection_date', { ascending: false })
      .order('collected_at', { ascending: false })
      .limit(50)

    if (filter === 'deleted') {
      query = query.not('deleted_at', 'is', null)
    } else {
      query = query.is('deleted_at', null)
      if (filter !== 'all') query = query.eq('status', filter)
    }

    query.then(async ({ data, error }) => {
      if (error) {
        setError(error.message)
        setBags([])
        setLoading(false)
        return
      }
      setBags(data ?? [])
      setLoading(false)

      // Only look up "deleted by" names when actually viewing the Deleted tab.
      const deleterIds = [...new Set((data ?? []).map(b => b.deleted_by).filter(Boolean))]
      if (deleterIds.length) {
        const { data: staffRows } = await supabase.from('staff_profiles').select('id, display_name').in('id', deleterIds)
        const map = {}
        for (const s of staffRows ?? []) map[s.id] = s.display_name
        setDeletedByNames(map)
      }
    })
  }, [filter, refreshKey, localRefresh])

  async function handleDeleteBag(bag) {
    const ok = window.confirm(
      `Delete bag ${bagRef(bag)} (${bag.hospitals?.name}, collected ${bag.collection_date})?\n\n` +
      `This removes it from the normal log. It stays recorded for audit purposes and can be reviewed under "Deleted."`
    )
    if (!ok) return
    setBusyId(bag.id)
    const { error } = await supabase
      .from('bags')
      .update({ deleted_at: new Date().toISOString(), deleted_by: profile.id })
      .eq('id', bag.id)
    setBusyId(null)
    if (error) {
      alert(`Couldn't delete: ${error.message}`)
      return
    }
    setLocalRefresh(k => k + 1)
  }

  return (
    <div className="bag-list">
      <div className="bag-list-header">
        <h2>Data log</h2>
        <div className="filter-tabs">
          <button className={filter === 'submitted' ? 'active' : ''} onClick={() => setFilter('submitted')}>Submitted</button>
          <button className={filter === 'in_progress' ? 'active' : ''} onClick={() => setFilter('in_progress')}>In progress</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'deleted' ? 'active' : ''} onClick={() => setFilter('deleted')}>Deleted</button>
        </div>
      </div>

      {loading && <p className="status-line">Loading…</p>}
      {error && <p className="status-line" style={{ color: 'var(--rust)' }}>Couldn't load: {error}</p>}
      {!loading && !error && bags.length === 0 && <p className="status-line">No bags here yet.</p>}

      <div className="bag-log">
        {bags.map(bag => (
          <div key={bag.id} className={`bag-log-entry ${bag.deleted_at ? 'bag-log-deleted' : ''}`}>
            <div className="bag-log-head">
              <div>
                {bag.deleted_at ? (
                  <span className="bag-status bag-status-deleted">Deleted</span>
                ) : (
                  <span className={`bag-status bag-status-${bag.status}`}>{bag.status === 'in_progress' ? 'In progress' : 'Submitted'}</span>
                )}
                <span className="bag-log-ref">{bagRef(bag)}</span>
                <span className="bag-log-loc">{bag.hospitals?.name} · {bag.bins?.code} ({bag.bins?.location_label})</span>
              </div>
              <div className="bag-log-meta">
                {bag.collection_date} · logged by {bag.staff_profiles?.display_name ?? 'Unknown'}
                {bag.deleted_at ? (
                  <span className="bag-log-deleted-note">
                    · deleted by {deletedByNames[bag.deleted_by] ?? 'Unknown'} on {new Date(bag.deleted_at).toLocaleDateString()}
                  </span>
                ) : (
                  <>
                    <button className="link-btn bag-log-edit" onClick={() => onOpenBag(bag.id)}>Edit</button>
                    {bag.status === 'submitted' && (
                      <button
                        className="link-btn bag-log-delete"
                        onClick={() => handleDeleteBag(bag)}
                        disabled={busyId === bag.id}
                      >
                        {busyId === bag.id ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {bag.medications?.length > 0 ? (
              <ul className="bag-log-items">
                {bag.medications.map(m => {
                  const { head, details } = formatMed(m)
                  return (
                    <li key={m.id}>
                      <span className="bag-log-item-name">{head}</span>
                      {details && <span className="bag-log-item-details"> — {details}</span>}
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="bag-log-empty">No medications logged yet.</p>
            )}

            {bag.photo_url && (
              <img src={bag.photo_url} alt="Bag contents" className="bag-log-photo" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
