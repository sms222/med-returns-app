import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

function formatMed(m) {
  const parts = []
  if (m.drug_name) parts.push(m.drug_name)
  if (m.brand_name) parts.push(`(${m.brand_name})`)
  if (m.strength) parts.push(m.strength)
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
  if (m.notes) details.push(m.notes)

  return { head, details: details.join(' · ') }
}

export default function BagList({ onOpenBag, refreshKey }) {
  const [bags, setBags] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('submitted') // 'in_progress' | 'submitted' | 'all'

  useEffect(() => {
    setLoading(true)
    let query = supabase
      .from('bags')
      .select('*, hospitals(name), bins(code, location_label), staff_profiles!bags_collected_by_fkey(display_name), medications(*)')
      .order('collection_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50)
    if (filter !== 'all') query = query.eq('status', filter)
    query.then(({ data }) => {
      setBags(data ?? [])
      setLoading(false)
    })
  }, [filter, refreshKey])

  return (
    <div className="bag-list">
      <div className="bag-list-header">
        <h2>Data log</h2>
        <div className="filter-tabs">
          <button className={filter === 'submitted' ? 'active' : ''} onClick={() => setFilter('submitted')}>Submitted</button>
          <button className={filter === 'in_progress' ? 'active' : ''} onClick={() => setFilter('in_progress')}>In progress</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>

      {loading && <p className="status-line">Loading…</p>}
      {!loading && bags.length === 0 && <p className="status-line">No bags here yet.</p>}

      <div className="bag-log">
        {bags.map(bag => (
          <div key={bag.id} className="bag-log-entry">
            <div className="bag-log-head">
              <div>
                <span className={`bag-status bag-status-${bag.status}`}>{bag.status === 'in_progress' ? 'In progress' : 'Submitted'}</span>
                <span className="bag-log-loc">{bag.hospitals?.name} · {bag.bins?.code} ({bag.bins?.location_label})</span>
              </div>
              <div className="bag-log-meta">
                {bag.collection_date} · logged by {bag.staff_profiles?.display_name ?? 'Unknown'}
                <button className="link-btn bag-log-edit" onClick={() => onOpenBag(bag.id)}>Edit</button>
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
