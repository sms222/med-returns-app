import { useState } from 'react'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Login from './components/Login'
import HomeSetup from './components/HomeSetup'
import DataEntry from './components/DataEntry'
import BagList from './components/BagList'
import Dashboard from './components/Dashboard'
import './App.css'

const TABS = [
  { key: 'entry', label: 'Log a bag' },
  { key: 'bags', label: 'Bags' },
  { key: 'overview', label: 'Overview' },
]

function Shell() {
  const { session, profile, loading, signOut } = useAuth()
  const [tab, setTab] = useState('entry')
  const [openBagId, setOpenBagId] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  if (loading) return <div className="loading-screen">Loading…</div>
  if (!session) return <Login />
  if (!profile) return <HomeSetup />

  function handleSaved() {
    setRefreshKey(k => k + 1)
    setOpenBagId(null)
    setTab('bags')
  }

  function handleOpenBag(id) {
    setOpenBagId(id)
    setTab('entry')
  }

  function handleNewBag() {
    setOpenBagId(null)
    setTab('entry')
  }

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <span className="app-title">Med Returns</span>
        <span className="app-user">{profile.display_name} · {profile.hospitals?.name} / {profile.bins?.code} ({profile.bins?.location_label})</span>
        <a className="link-btn" href="mailto:shamin@ukm.edu.my">Help</a>
        <button className="link-btn" onClick={signOut}>Sign out</button>
      </header>

      <nav className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`tab-btn ${tab === t.key ? 'active' : ''}`}
            onClick={() => { setTab(t.key); if (t.key === 'entry' && !openBagId) handleNewBag() }}
          >
            {t.label}
          </button>
        ))}
        {tab === 'entry' && openBagId && (
          <button className="tab-new-bag" onClick={handleNewBag}>+ New bag instead</button>
        )}
      </nav>

      <main className="single-pane">
        {tab === 'entry' && (
          <DataEntry
            bagId={openBagId}
            onSaved={handleSaved}
            onCancel={openBagId ? () => { setOpenBagId(null); setTab('bags') } : null}
          />
        )}
        {tab === 'bags' && <BagList onOpenBag={handleOpenBag} refreshKey={refreshKey} />}
        {tab === 'overview' && <Dashboard refreshKey={refreshKey} />}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
