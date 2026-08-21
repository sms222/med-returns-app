import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function BagList({ onOpenBag, refreshKey }) {
  const [bags, setBags] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('in_progress') // 'in_progress' | 'submitted' | 'all'

  useEffect(() => {
    setLoading(true)
    let query = supabase
      .from('bags')
      .select('*, hospitals(name), bins(code, location_label), staff_profiles!bags_collected_by_fkey(display_name)')
      .order('collection_date', { ascending: false })
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
        <h2>Bags</h2>
        <div className="filter-tabs">
          <button className={filter === 'in_progress' ? 'active' : ''} onClick={() => setFilter('in_progress')}>In progress</button>
          <button className={filter === 'submitted' ? 'active' : ''} onClick={() => setFilter('submitted')}>Submitted</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>

      {loading && <p className="status-line">Loading…</p>}
      {!loading && bags.length === 0 && <p className="status-line">No bags here yet.</p>}

      <div className="bag-cards">
        {bags.map(bag => (
          <button key={bag.id} className="bag-card" onClick={() => onOpenBag(bag.id)}>
            <div className="bag-card-top">
              <span className={`bag-status bag-status-${bag.status}`}>{bag.status === 'in_progress' ? 'In progress' : 'Submitted'}</span>
              <span className="bag-card-date">{bag.collection_date}</span>
            </div>
            <div className="bag-card-loc">{bag.hospitals?.name} · {bag.bins?.code} ({bag.bins?.location_label})</div>
            <div className="bag-card-by">Logged by {bag.staff_profiles?.display_name ?? 'Unknown'}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
