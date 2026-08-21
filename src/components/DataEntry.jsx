import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { transcribeAudio, parseTranscriptToMedications } from '../lib/voice'

const PACK_TYPES = ['bottle', 'vial', 'blister', 'strip', 'box', 'other']
const CONDITIONS = ['ok', 'damaged', 'exposed', 'contaminated']

function emptyRow() {
  return {
    id: null, drug_name: '', brand_name: '', strength: '', pack_type: '',
    quantity_remaining: '', manufacturer: '', patient_mrn: '', patient_name: '',
    dispensed_date: '', expiry_date: '', batch_number: '',
    box_intact: null, condition_flag: 'ok', reason_for_return: '', expired_at_return: false,
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// bagId: null to start a new bag, or an existing bag's id to reopen/resume it.
export default function DataEntry({ bagId, onSaved, onCancel }) {
  const { profile } = useAuth()
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [rows, setRows] = useState([emptyRow()])
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [collectionDate, setCollectionDate] = useState(todayISO())
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  const [loadingBag, setLoadingBag] = useState(!!bagId)
  const [existingStatus, setExistingStatus] = useState('in_progress')
  const [deletedRowIds, setDeletedRowIds] = useState([])

  const mediaRecorder = useRef(null)
  const chunks = useRef([])

  useEffect(() => {
    if (!bagId) return
    setLoadingBag(true)
    Promise.all([
      supabase.from('bags').select('*').eq('id', bagId).single(),
      supabase.from('medications').select('*').eq('bag_id', bagId).order('created_at'),
    ]).then(([bagRes, medRes]) => {
      if (bagRes.data) {
        setCollectionDate(bagRes.data.collection_date)
        setExistingStatus(bagRes.data.status)
        setTranscript(bagRes.data.raw_transcript || '')
        if (bagRes.data.photo_url) setPhotoPreview(bagRes.data.photo_url)
      }
      if (medRes.data?.length) setRows(medRes.data)
      setLoadingBag(false)
    })
  }, [bagId])

  async function startRecording() {
    setStatus('')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    chunks.current = []
    const mr = new MediaRecorder(stream)
    mr.ondataavailable = e => chunks.current.push(e.data)
    mr.onstop = handleRecordingStop
    mr.start()
    mediaRecorder.current = mr
    setRecording(true)
  }

  function stopRecording() {
    mediaRecorder.current?.stop()
    mediaRecorder.current?.stream.getTracks().forEach(t => t.stop())
    setRecording(false)
  }

  async function handleRecordingStop() {
    const blob = new Blob(chunks.current, { type: 'audio/webm' })
    setTranscribing(true)
    setStatus('Transcribing…')
    try {
      const text = await transcribeAudio(blob)
      setTranscript(prev => (prev ? prev + ' ' : '') + text)
      setStatus('Parsing into fields…')
      const meds = await parseTranscriptToMedications(text)
      if (meds.length) {
        setRows(prev => {
          const base = prev.length === 1 && !prev[0].drug_name ? [] : prev
          return [...base, ...meds.map(m => ({ ...emptyRow(), ...m }))]
        })
      }
      setStatus('Done — check the rows below before saving.')
    } catch (err) {
      console.error(err)
      setStatus(`Voice pipeline error: ${err.message}`)
    } finally {
      setTranscribing(false)
    }
  }

  function updateRow(i, field, value) {
    setRows(rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))
  }

  function addRow() {
    setRows([...rows, emptyRow()])
  }

  function removeRow(i) {
    const row = rows[i]
    if (row.id) setDeletedRowIds(prev => [...prev, row.id])
    setRows(rows.filter((_, idx) => idx !== i))
  }

  function handlePhoto(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  async function persist(finalStatus) {
    setSaving(true)
    setStatus(finalStatus === 'submitted' ? 'Submitting…' : 'Saving draft…')
    try {
      let photoUrl = photoFile ? null : (photoPreview?.startsWith('http') ? photoPreview : null)
      if (photoFile) {
        const path = `${profile.hospital_id}/${Date.now()}-${photoFile.name}`
        const { error: upErr } = await supabase.storage.from('bag-photos').upload(path, photoFile)
        if (upErr) throw upErr
        photoUrl = supabase.storage.from('bag-photos').getPublicUrl(path).data.publicUrl
      }

      const bagPayload = {
        hospital_id: profile.hospital_id,
        bin_id: profile.bin_id,
        collected_by: profile.id,
        collection_date: collectionDate,
        photo_url: photoUrl,
        raw_transcript: transcript || null,
        status: finalStatus,
      }

      let bag
      if (bagId) {
        const { data, error } = await supabase.from('bags').update(bagPayload).eq('id', bagId).select().single()
        if (error) throw error
        bag = data
      } else {
        const { data, error } = await supabase.from('bags').insert(bagPayload).select().single()
        if (error) throw error
        bag = data
      }

      if (deletedRowIds.length) {
        const { error } = await supabase.from('medications').delete().in('id', deletedRowIds)
        if (error) throw error
      }

      const validRows = rows.filter(r => r.drug_name?.trim())
      const toInsert = validRows.filter(r => !r.id).map(r => ({ ...r, id: undefined, bag_id: bag.id, quantity_remaining: r.quantity_remaining || null }))
      const toUpdate = validRows.filter(r => r.id)

      if (toInsert.length) {
        const { error } = await supabase.from('medications').insert(toInsert)
        if (error) throw error
      }
      for (const r of toUpdate) {
        const { id, ...fields } = r
        const { error } = await supabase.from('medications').update({ ...fields, quantity_remaining: fields.quantity_remaining || null }).eq('id', id)
        if (error) throw error
      }

      setStatus(finalStatus === 'submitted' ? 'Submitted ✓' : 'Draft saved ✓')
      onSaved?.(bag.id)
    } catch (err) {
      console.error(err)
      setStatus(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  if (loadingBag) return <div className="entry-panel"><p className="status-line">Loading bag…</p></div>

  return (
    <div className="entry-panel">
      <div className="entry-header">
        <div>
          <h2>{bagId ? 'Edit bag' : 'Log a bag'}</h2>
          <p className="entry-sub">{profile?.hospitals?.name} · {profile?.bins?.code} ({profile?.bins?.location_label})</p>
        </div>
        <button
          className={`mic-btn ${recording ? 'recording' : ''}`}
          onClick={recording ? stopRecording : startRecording}
          disabled={transcribing}
        >
          {recording ? '● Stop' : transcribing ? 'Working…' : '🎙 Speak'}
        </button>
      </div>

      <div className="field-row">
        <label className="inline-field">
          Collection date
          <input type="date" value={collectionDate} onChange={e => setCollectionDate(e.target.value)} />
        </label>
        {bagId && <span className={`bag-status bag-status-${existingStatus}`}>{existingStatus === 'in_progress' ? 'In progress' : 'Submitted'}</span>}
        {onCancel && <button className="link-btn" onClick={onCancel}>← Back to bags</button>}
      </div>

      {status && <p className="status-line">{status}</p>}

      {transcript && (
        <details className="transcript-box">
          <summary>Transcript</summary>
          <p>{transcript}</p>
        </details>
      )}

      <div className="photo-row">
        <label className="photo-btn">
          📷 {photoPreview ? 'Retake bag photo' : 'Add bag photo'}
          <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} hidden />
        </label>
        {photoPreview && <img src={photoPreview} alt="Bag preview" className="photo-preview" />}
      </div>

      <div className="table-wrap">
        <table className="entry-table">
          <thead>
            <tr>
              <th>Drug</th><th>Brand</th><th>Strength</th><th>Pack</th><th>Qty left</th>
              <th>Manufacturer</th><th>MRN</th><th>Patient</th><th>Dispensed</th><th>Expiry</th>
              <th>Batch</th><th>Box intact</th><th>Condition</th><th>Expired?</th><th>Reason</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id ?? `new-${i}`}>
                <td><input value={row.drug_name} onChange={e => updateRow(i, 'drug_name', e.target.value)} /></td>
                <td><input value={row.brand_name} onChange={e => updateRow(i, 'brand_name', e.target.value)} /></td>
                <td><input value={row.strength} onChange={e => updateRow(i, 'strength', e.target.value)} /></td>
                <td>
                  <select value={row.pack_type || ''} onChange={e => updateRow(i, 'pack_type', e.target.value)}>
                    <option value="">—</option>
                    {PACK_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td><input type="number" value={row.quantity_remaining ?? ''} onChange={e => updateRow(i, 'quantity_remaining', e.target.value)} /></td>
                <td><input value={row.manufacturer} onChange={e => updateRow(i, 'manufacturer', e.target.value)} /></td>
                <td><input value={row.patient_mrn} onChange={e => updateRow(i, 'patient_mrn', e.target.value)} /></td>
                <td><input value={row.patient_name} onChange={e => updateRow(i, 'patient_name', e.target.value)} /></td>
                <td><input type="date" value={row.dispensed_date || ''} onChange={e => updateRow(i, 'dispensed_date', e.target.value)} /></td>
                <td><input type="date" value={row.expiry_date || ''} onChange={e => updateRow(i, 'expiry_date', e.target.value)} /></td>
                <td><input value={row.batch_number} onChange={e => updateRow(i, 'batch_number', e.target.value)} /></td>
                <td>
                  <select value={row.box_intact === null || row.box_intact === undefined ? '' : String(row.box_intact)} onChange={e => updateRow(i, 'box_intact', e.target.value === '' ? null : e.target.value === 'true')}>
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </td>
                <td>
                  <select value={row.condition_flag || 'ok'} onChange={e => updateRow(i, 'condition_flag', e.target.value)}>
                    {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td>
                  <input type="checkbox" checked={!!row.expired_at_return} onChange={e => updateRow(i, 'expired_at_return', e.target.checked)} />
                </td>
                <td><input value={row.reason_for_return} onChange={e => updateRow(i, 'reason_for_return', e.target.value)} /></td>
                <td><button className="row-remove" onClick={() => removeRow(i)} title="Remove row">✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="entry-actions">
        <button className="secondary" onClick={addRow}>+ Add medication row</button>
        <div className="entry-actions-right">
          <button className="secondary" onClick={() => persist('in_progress')} disabled={saving}>
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button className="primary" onClick={() => persist('submitted')} disabled={saving}>
            {saving ? 'Submitting…' : 'Submit bag'}
          </button>
        </div>
      </div>
    </div>
  )
}
