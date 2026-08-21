import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, CartesianGrid, LineChart, Line } from 'recharts'
import { supabase } from '../lib/supabase'

const COLORS = ['#2b6f6c', '#e0a458', '#c1524a', '#7d8f69', '#4a6fa5', '#9b7fb8', '#d97b8f', '#6b8fa3']

function currency(n) {
  return `RM ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function Dashboard({ refreshKey }) {
  const [meds, setMeds] = useState([])
  const [bags, setBags] = useState([])
  const [drugRef, setDrugRef] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      supabase.from('medications').select('*, bags!inner(hospital_id, bin_id, collection_date, hospitals(name), bins(code, location_label), collected_by, deleted_at, staff_profiles!bags_collected_by_fkey(display_name))').is('bags.deleted_at', null).order('created_at', { ascending: false }).limit(2000),
      supabase.from('bags').select('id, collection_date, hospitals(name), collected_by, staff_profiles!bags_collected_by_fkey(display_name)').is('deleted_at', null).order('collection_date', { ascending: false }).limit(2000),
      supabase.from('drug_reference').select('drug_name, drug_class, unit_cost'),
    ]).then(([medRes, bagRes, refRes]) => {
      setMeds(medRes.data ?? [])
      setBags(bagRes.data ?? [])
      const map = {}
      for (const r of refRes.data ?? []) {
        if (r.drug_name) map[r.drug_name.trim().toLowerCase()] = r
      }
      setDrugRef(map)
      setLoading(false)
    })
  }, [refreshKey])

  // Enrich each medication with matched reference data (class, unit cost).
  const enriched = useMemo(() => {
    return meds.map(m => {
      const key = m.drug_name?.trim().toLowerCase()
      const ref = key ? drugRef[key] : null
      const qty = Number(m.quantity_remaining) || 0
      const cost = ref?.unit_cost != null ? ref.unit_cost * qty : null
      return { ...m, drug_class: ref?.drug_class ?? null, unit_cost: ref?.unit_cost ?? null, est_cost: cost }
    })
  }, [meds, drugRef])

  const totalCost = useMemo(
    () => enriched.reduce((sum, m) => sum + (m.est_cost ?? 0), 0),
    [enriched]
  )
  const unmatchedCount = useMemo(
    () => enriched.filter(m => m.drug_name && m.unit_cost == null).length,
    [enriched]
  )

  const topDrugs = useMemo(() => {
    const counts = {}
    for (const m of meds) {
      const name = m.drug_name?.trim() || 'Unknown'
      counts[name] = (counts[name] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }))
  }, [meds])

  const topDrugsByCost = useMemo(() => {
    const totals = {}
    for (const m of enriched) {
      if (m.est_cost == null) continue
      const name = m.drug_name?.trim() || 'Unknown'
      totals[name] = (totals[name] || 0) + m.est_cost
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }))
  }, [enriched])

  const costByClass = useMemo(() => {
    const totals = {}
    for (const m of enriched) {
      if (m.est_cost == null) continue
      const cls = m.drug_class || 'Unclassified'
      totals[cls] = (totals[cls] || 0) + m.est_cost
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
  }, [enriched])

  const volumeByClass = useMemo(() => {
    const counts = {}
    for (const m of enriched) {
      const cls = m.drug_class || 'Unclassified'
      counts[cls] = (counts[cls] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value }))
  }, [enriched])

  const byHospital = useMemo(() => {
    const counts = {}
    for (const b of bags) {
      const name = b.hospitals?.name || 'Unknown'
      counts[name] = (counts[name] || 0) + 1
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [bags])

  const expiredShare = useMemo(() => {
    const now = new Date()
    const expired = meds.filter(m => m.expiry_date && new Date(m.expiry_date) < now).length
    const notExpired = meds.length - expired
    return [
      { name: 'Expired', value: expired },
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

  const bagsOverTime = useMemo(() => {
    const counts = {}
    for (const b of bags) {
      const d = b.collection_date
      if (!d) continue
      counts[d] = (counts[d] || 0) + 1
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }))
  }, [bags])

  const staffActivity = useMemo(() => {
    const counts = {}
    for (const b of bags) {
      const name = b.staff_profiles?.display_name || 'Unknown'
      counts[name] = (counts[name] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  }, [bags])

  if (loading) return <div className="dash-panel"><p className="status-line">Loading dashboard…</p></div>

  return (
    <div className="dash-panel">
      <h2>Overview</h2>
      <div className="stat-row">
        <div className="stat-card"><span className="stat-num">{bags.length}</span><span className="stat-label">Bags logged</span></div>
        <div className="stat-card"><span className="stat-num">{meds.length}</span><span className="stat-label">Medications</span></div>
        <div className="stat-card"><span className="stat-num">{meds.filter(m => m.expiry_date && new Date(m.expiry_date) < new Date()).length}</span><span className="stat-label">Expired</span></div>
        <div className="stat-card"><span className="stat-num">{currency(totalCost)}</span><span className="stat-label">Est. cost (matched items)</span></div>
      </div>
      {unmatchedCount > 0 && (
        <p className="status-line dash-note">
          {unmatchedCount} logged medication{unmatchedCount === 1 ? '' : 's'} not matched to a cost/class yet —
          add them to the <code>drug_reference</code> table in Supabase to include them here.
        </p>
      )}

      <h3 className="dash-section-title">Cost analysis</h3>
      <div className="chart-grid">
        <div className="chart-block">
          <h3>Cost by drug class</h3>
          {costByClass.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={costByClass} dataKey="value" nameKey="name" outerRadius={75} label={d => currency(d.value)}>
                  {costByClass.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={v => currency(v)} />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="dash-empty">No cost data yet — add unit costs to drug_reference.</p>}
        </div>

        <div className="chart-block">
          <h3>Top drugs by cost</h3>
          {topDrugsByCost.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={topDrugsByCost} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={v => `RM${v}`} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 12 }} />
                <Tooltip formatter={v => currency(v)} />
                <Bar dataKey="cost" fill="#c1524a" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <p className="dash-empty">No cost data yet — add unit costs to drug_reference.</p>}
        </div>
      </div>

      <h3 className="dash-section-title">Composition</h3>
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
          <h3>Volume by drug class</h3>
          {volumeByClass.length ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={volumeByClass} dataKey="value" nameKey="name" outerRadius={75} label>
                  {volumeByClass.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="dash-empty">No class data yet — add drug_class to drug_reference.</p>}
        </div>

        <div className="chart-block">
          <h3>Expired at review</h3>
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

      <h3 className="dash-section-title">Trends &amp; location</h3>
      <div className="chart-block">
        <h3>Bags collected over time</h3>
        {bagsOverTime.length ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={bagsOverTime}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line type="monotone" dataKey="count" stroke="#2b6f6c" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="dash-empty">No bags logged yet.</p>}
      </div>

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

      <h3 className="dash-section-title">Staff activity</h3>
      <div className="chart-block">
        <h3>Bags logged per staff member</h3>
        <ResponsiveContainer width="100%" height={Math.max(140, staffActivity.length * 32)}>
          <BarChart data={staffActivity} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="count" fill="#4a6fa5" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
