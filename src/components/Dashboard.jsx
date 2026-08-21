import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, CartesianGrid } from 'recharts'
import { supabase } from '../lib/supabase'

const COLORS = ['#2b6f6c', '#e0a458', '#c1524a', '#7d8f69', '#4a6fa5', '#9b7fb8']

export default function Dashboard({ refreshKey }) {
  const [meds, setMeds] = useState([])
  const [bags, setBags] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      supabase.from('medications').select('*, bags(hospital_id, bin_id, collected_at, hospitals(name), bins(code, location_label))').order('created_at', { ascending: false }).limit(1000),
      supabase.from('bags').select('id, collected_at, hospitals(name)').order('collected_at', { ascending: false }).limit(1000),
    ]).then(([medRes, bagRes]) => {
      setMeds(medRes.data ?? [])
      setBags(bagRes.data ?? [])
      setLoading(false)
    })
  }, [refreshKey])

  const topDrugs = useMemo(() => {
    const counts = {}
    for (const m of meds) {
      const name = m.drug_name?.trim() || 'Unknown'
      counts[name] = (counts[name] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }))
  }, [meds])

  const byHospital = useMemo(() => {
    const counts = {}
    for (const b of bags) {
      const name = b.hospitals?.name || 'Unknown'
      counts[name] = (counts[name] || 0) + 1
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [bags])

  const expiredShare = useMemo(() => {
    const expired = meds.filter(m => m.expired_at_return).length
    const notExpired = meds.length - expired
    return [
      { name: 'Expired at return', value: expired },
      { name: 'Not expired', value: notExpired },
    ]
  }, [meds])

  const conditionCounts = useMemo(() => {
    const counts = {}
    for (const m of meds) {
      const c = m.condition_flag || 'ok'
      counts[c] = (counts[c] || 0) + 1
    }
    return Object.entries(counts).map(([name, count]) => ({ name, count }))
  }, [meds])

  if (loading) return <div className="dash-panel"><p className="status-line">Loading dashboard…</p></div>

  return (
    <div className="dash-panel">
      <h2>Overview</h2>
      <div className="stat-row">
        <div className="stat-card"><span className="stat-num">{bags.length}</span><span className="stat-label">Bags logged</span></div>
        <div className="stat-card"><span className="stat-num">{meds.length}</span><span className="stat-label">Medications</span></div>
        <div className="stat-card"><span className="stat-num">{meds.filter(m => m.expired_at_return).length}</span><span className="stat-label">Expired at return</span></div>
      </div>

      <div className="chart-block">
        <h3>Top returned medications</h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={topDrugs} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="count" fill="#2b6f6c" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-grid">
        <div className="chart-block">
          <h3>Returns by hospital</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={byHospital} dataKey="value" nameKey="name" outerRadius={75} label>
                {byHospital.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-block">
          <h3>Expired at return</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={expiredShare} dataKey="value" nameKey="name" outerRadius={75} label>
                {expiredShare.map((_, i) => <Cell key={i} fill={i === 0 ? '#c1524a' : '#7d8f69'} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="chart-block">
        <h3>Condition on return</h3>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={conditionCounts}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" fill="#e0a458" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
