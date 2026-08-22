import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { transcribeAudio, parseTranscriptToMedications, fetchKnownDrugNames, speak, parseSingleFieldAnswer, unlockSpeech } from '../lib/voice'

const PACK_TYPES = ['tablet', 'capsule', 'bottle', 'vial', 'blister', 'strip', 'ampoule', 'cartridge', 'sachet', 'box', 'other']

// Fields the assistant will proactively ask about if left blank after
// dictation. Order matters — it asks in this sequence. type controls how the
// spoken answer gets interpreted and confirmed back.
const CORE_FIELDS = [
  { key: 'quantity_remaining', type: 'number', label: 'quantity remaining', question: name => `How many are left for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'pack_type', type: 'text', label: 'unit of measure (tablet, capsule, bottle, vial, blister, strip, ampoule, cartridge, sachet, or box)', question: name => `What's the unit for ${name} — tablet, strip, bottle, or something else?`, confirm: v => `Saved as ${v}.` },
  { key: 'patient_mrn', type: 'text', label: 'patient MRN', question: name => `What's the patient's MRN for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'expiry_date', type: 'text', label: 'expiry date, formatted YYYY-MM-DD', question: name => `What's the expiry date for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'condition_flag', type: 'boolean', label: 'condition — good or not good, answer yes or no', question: name => `Is the condition for ${name} good?`, confirm: v => `Logged as ${v ? 'good' : 'not good'}.`, toStored: v => (v ? 'ok' : 'not_good') },
  { key: 'sealed', type: 'boolean', label: 'sealed — answer yes or no', question: name => `Is ${name} sealed?`, confirm: v => `Saved as ${v ? 'yes' : 'no'}.` },
]

function emptyRow() {
  return {
    id: null, drug_name: '', brand_name: '', pack_type: '',
    quantity_remaining: '', patient_mrn: '', patient_name: '',
    dispensed_date: '', expiry_date: '', batch_number: '',
    condition_flag: null, label_attached: null, sealed: null,
    disposition: '', source_clinic: '', notes: '',
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// Cycles a checkbox-style field through: unanswered → good/yes → bad/no → unanswered.
function cycleConditionFlag(current) {
  if (current == null) return 'ok'
  if (current === 'ok') return 'not_good'
  return null
}
function cycleBool(current) {
  if (current == null) return true
  if (current === true) return false
  return null
}
function triIcon(value, trueVal) {
  if (value == null) return '—'
  return value === trueVal ? '✓' : '✗'
}
function triClass(value, trueVal) {
  if (value == null) return 'is-unset'
  return value === trueVal ? 'is-yes' : 'is-no'
}

function findNextMissing(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].drug_name?.trim()) continue
    for (const f of CORE_FIELDS) {
      const val = rows[i][f.key]
      if (val === '' || val === null || val === undefined) {
        return { rowIndex: i, field: f.key, question: f.question(rows[i].drug_name), type: f.type, label: f.label, confirm: f.confirm, toStored: f.toStored }
      }
    }
  }
  return null
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
  const [existingBagNumber, setExistingBagNumber] = useState(null)
  const [deletedRowIds, setDeletedRowIds] = useState([])
  const [assistMode, setAssistMode] = useState(false)
  const [pending, setPending] = useState(null) // { rowIndex, field, question } while assistant is waiting for an answer
  const [hospitals, setHospitals] = useState([])
  const [bins, setBins] = useState([])
  const [hospitalId, setHospitalId] = useState('')
  const [binId, setBinId] = useState('')

  const mediaRecorder = useRef(null)
  const chunks = useRef([])
  const knownDrugsRef = useRef(null)
  const pendingRef = useRef(null)
  const rowsRef = useRef(rows)
  const silenceWatcherRef = useRef(null)

  // Keep refs in sync so the recorder's onstop callback — which can end up
  // holding a stale closure across several auto-continue cycles — always
  // reads the latest pending question and rows instead of an old snapshot.
  useEffect(() => { pendingRef.current = pending }, [pending])
  useEffect(() => { rowsRef.current = rows }, [rows])

  // These update the ref immediately (not waiting for the effect above) so
  // the very next mic recording — which can start within the same tick —
  // never reads a one-step-behind value.
  function setPendingNow(value) {
    pendingRef.current = value
    setPending(value)
  }
  function setRowsNow(value) {
    rowsRef.current = value
    setRows(value)
  }

  useEffect(() => {
    fetchKnownDrugNames().then(names => { knownDrugsRef.current = names })
    supabase.from('hospitals').select('*').order('name').then(({ data }) => setHospitals(data ?? []))
  }, [])

  // Default to the staff member's own hospital/bin for a brand new bag.
  useEffect(() => {
    if (!bagId && profile) {
      setHospitalId(profile.hospital_id)
      setBinId(profile.bin_id)
    }
  }, [bagId, profile])

  useEffect(() => {
    if (!hospitalId) return setBins([])
    supabase.from('bins').select('*').eq('hospital_id', hospitalId).order('code')
      .then(({ data }) => setBins(data ?? []))
  }, [hospitalId])

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
        setHospitalId(bagRes.data.hospital_id)
        setBinId(bagRes.data.bin_id)
        setExistingBagNumber(bagRes.data.bag_number)
        if (bagRes.data.photo_url) setPhotoPreview(bagRes.data.photo_url)
      }
      if (medRes.data?.length) setRows(medRes.data)
      setLoadingBag(false)
    })
  }, [bagId])

  // Watches mic input volume and auto-stops recording after a period of
  // silence, so answering a follow-up question doesn't need a manual tap.
  function watchForSilence(stream, mr) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    const audioCtx = new AudioCtx()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const SILENCE_RMS_THRESHOLD = 6
    const SILENCE_DURATION_MS = 1300
    const MIN_RECORDING_MS = 500
    const MAX_RECORDING_MS = 20000
    const startedAt = Date.now()
    let silenceStartedAt = null

    function tick() {
      if (mr.state !== 'recording') {
        audioCtx.close().catch(() => {})
        return
      }
      analyser.getByteTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sumSquares += v * v
      }
      const rms = Math.sqrt(sumSquares / data.length) * 100
      const elapsed = Date.now() - startedAt

      if (elapsed > MIN_RECORDING_MS) {
        if (rms < SILENCE_RMS_THRESHOLD) {
          if (silenceStartedAt === null) silenceStartedAt = Date.now()
          if (Date.now() - silenceStartedAt > SILENCE_DURATION_MS) {
            audioCtx.close().catch(() => {})
            stopRecording()
            return
          }
        } else {
          silenceStartedAt = null
        }
      }

      if (elapsed > MAX_RECORDING_MS) {
        audioCtx.close().catch(() => {})
        stopRecording()
        return
      }

      silenceWatcherRef.current = requestAnimationFrame(tick)
    }
    silenceWatcherRef.current = requestAnimationFrame(tick)
  }

  async function beginListening(autoStop = false) {
    try {
      unlockSpeech()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks.current = []
      const mr = new MediaRecorder(stream)
      mr.ondataavailable = e => chunks.current.push(e.data)
      mr.onstop = handleRecordingStop
      mr.start()
      mediaRecorder.current = mr
      setRecording(true)
      if (autoStop) watchForSilence(stream, mr)
    } catch (err) {
      console.warn('Could not auto-start listening — tap the mic to answer.', err)
    }
  }

  function stopRecording() {
    if (silenceWatcherRef.current) {
      cancelAnimationFrame(silenceWatcherRef.current)
      silenceWatcherRef.current = null
    }
    mediaRecorder.current?.stop()
    mediaRecorder.current?.stream.getTracks().forEach(t => t.stop())
    setRecording(false)
  }

  async function askAboutNextMissing(currentRows, confirmationText) {
    if (confirmationText) {
      setStatus(confirmationText)
      await speak(confirmationText)
    }
    const next = findNextMissing(currentRows)
    setPendingNow(next)
    if (next) {
      setStatus(`Assistant: ${next.question}`)
      await speak(next.question)
      await beginListening(true)
    } else {
      setStatus('Everything looks filled in — ready to save.')
      await speak('All set — ready to save.')
    }
  }

  async function handleRecordingStop() {
    const blob = new Blob(chunks.current, { type: 'audio/webm' })
    setTranscribing(true)
    const currentPending = pendingRef.current

    // Answering a follow-up question from the assistant.
    if (currentPending) {
      setStatus('Listening for your answer…')
      try {
        const text = await transcribeAudio(blob)
        setTranscript(prev => (prev ? prev + ' ' : '') + text)
        const raw = await parseSingleFieldAnswer(currentPending.label ?? currentPending.field, text)
        const lower = raw.toLowerCase().trim()

        let value = raw
        if (currentPending.type === 'boolean') {
          if (/\b(yes|yeah|yep|correct|good|sealed|true)\b/.test(lower)) value = true
          else if (/\b(no|nope|not\s*good|unsealed|bad|false)\b/.test(lower)) value = false
          else value = null
        } else if (currentPending.type === 'enum') {
          value = currentPending.options?.find(o => lower.includes(o)) ?? null
        } else if (!raw || !raw.trim()) {
          value = null
        }

        if (value === null || value === '') {
          setStatus(`Didn't catch that clearly — asking again.`)
          await speak(`Sorry, I didn't quite catch that. ${currentPending.question}`)
          await beginListening(true)
        } else {
          const storedValue = currentPending.toStored ? currentPending.toStored(value) : value
          const next = rowsRef.current.map((r, idx) => (idx === currentPending.rowIndex ? { ...r, [currentPending.field]: storedValue } : r))
          setRowsNow(next)
          const confirmText = currentPending.confirm ? currentPending.confirm(value) : `Saved as ${value}.`
          await askAboutNextMissing(next, confirmText)
        }
      } catch (err) {
        console.error(err)
        setStatus(`Voice pipeline error: ${err.message}`)
      } finally {
        setTranscribing(false)
      }
      return
    }

    // Normal dictation.
    setStatus('Transcribing…')
    try {
      const text = await transcribeAudio(blob)
      setTranscript(prev => (prev ? prev + ' ' : '') + text)
      setStatus('Parsing into fields…')
      const meds = await parseTranscriptToMedications(text, knownDrugsRef.current ?? [])
      let updatedRows = rowsRef.current
      if (meds.length) {
        updatedRows = (rowsRef.current.length === 1 && !rowsRef.current[0].drug_name ? [] : rowsRef.current).concat(
          meds.map(m => ({ ...emptyRow(), ...m }))
        )
        setRowsNow(updatedRows)
      }
      if (assistMode) {
        await askAboutNextMissing(updatedRows)
      } else {
        setStatus('Done — check the rows below before saving.')
      }
    } catch (err) {
      console.error(err)
      setStatus(`Voice pipeline error: ${err.message}`)
    } finally {
      setTranscribing(false)
    }
  }

  function updateRow(i, field, value) {
    setRowsNow(rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))
  }

  function addRow() {
    setRowsNow([...rows, emptyRow()])
  }

  function removeRow(i) {
    const row = rows[i]
    if (row.id) setDeletedRowIds(prev => [...prev, row.id])
    setRowsNow(rows.filter((_, idx) => idx !== i))
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
        const path = `${hospitalId}/${Date.now()}-${photoFile.name}`
        const { error: upErr } = await supabase.storage.from('bag-photos').upload(path, photoFile)
        if (upErr) throw upErr
        photoUrl = supabase.storage.from('bag-photos').getPublicUrl(path).data.publicUrl
      }

      const bagPayload = {
        hospital_id: hospitalId,
        bin_id: binId,
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
      const toInsert = validRows.filter(r => !r.id).map(r => ({ ...r, id: undefined, bag_id: bag.id, quantity_remaining: r.quantity_remaining || null, disposition: r.disposition || null }))
      const toUpdate = validRows.filter(r => r.id)

      if (toInsert.length) {
        const { error } = await supabase.from('medications').insert(toInsert)
        if (error) throw error
      }
      for (const r of toUpdate) {
        const { id, ...fields } = r
        const { error } = await supabase.from('medications').update({ ...fields, quantity_remaining: fields.quantity_remaining || null, disposition: fields.disposition || null }).eq('id', id)
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
        </div>
        <div className="voice-controls">
          <div className="mode-toggle">
            <button className={!assistMode ? 'active' : ''} onClick={() => setAssistMode(false)}>Quick fill</button>
            <button className={assistMode ? 'active' : ''} onClick={() => setAssistMode(true)}>Assisted</button>
          </div>
          <button
            className={`mic-btn ${recording ? 'recording' : ''} ${pending ? 'pending' : ''}`}
            onClick={recording ? stopRecording : beginListening}
            disabled={transcribing}
          >
            {recording ? '● Stop' : transcribing ? 'Working…' : pending ? '🎙 Answer' : '🎙 Speak'}
          </button>
        </div>
      </div>

      <div className="field-row">
        <label className="inline-field">
          Hospital
          <select value={hospitalId} onChange={e => { setHospitalId(e.target.value); setBinId('') }}>
            {hospitals.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </label>
        <label className="inline-field">
          Bin
          <select value={binId} onChange={e => setBinId(e.target.value)} disabled={!hospitalId}>
            {bins.map(b => <option key={b.id} value={b.id}>{b.code} — {b.location_label}</option>)}
          </select>
        </label>
        <label className="inline-field">
          Collection date
          <input type="date" value={collectionDate} onChange={e => setCollectionDate(e.target.value)} />
        </label>
        {bagId && (
          <>
            <span className="bag-log-ref">
              {bins.find(b => b.id === binId)?.code ?? ''}-{existingBagNumber != null ? String(existingBagNumber).padStart(3, '0') : '???'}
            </span>
            <span className={`bag-status bag-status-${existingStatus}`}>{existingStatus === 'in_progress' ? 'In progress' : 'Submitted'}</span>
          </>
        )}
        {onCancel && <button className="link-btn" onClick={onCancel}>← Back to bags</button>}
      </div>

      {status && <p className={`status-line ${pending ? 'status-asking' : ''}`}>{status}</p>}

      <div className="transcript-live">
        <span className="transcript-live-label">Transcript (editable)</span>
        <textarea
          value={transcript}
          onChange={e => setTranscript(e.target.value)}
          placeholder="Nothing said yet — tap Speak to begin."
          rows={5}
        />
      </div>

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
              <th>Drug</th><th>Brand</th><th>UOM</th><th>Qty left</th>
              <th>MRN</th><th>Patient</th><th>Dispensed</th><th>Expiry</th>
              <th>Batch/Lot No.</th><th>Condition</th><th>Label</th><th>Sealed</th>
              <th>Action</th><th>Clinic</th><th>Notes</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id ?? `new-${i}`}>
                <td><input value={row.drug_name} onChange={e => updateRow(i, 'drug_name', e.target.value)} /></td>
                <td><input value={row.brand_name} onChange={e => updateRow(i, 'brand_name', e.target.value)} /></td>
                <td>
                  <select value={row.pack_type || ''} onChange={e => updateRow(i, 'pack_type', e.target.value)}>
                    <option value="">—</option>
                    {PACK_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td><input type="number" value={row.quantity_remaining ?? ''} onChange={e => updateRow(i, 'quantity_remaining', e.target.value)} /></td>
                <td><input value={row.patient_mrn} onChange={e => updateRow(i, 'patient_mrn', e.target.value)} /></td>
                <td><input value={row.patient_name} onChange={e => updateRow(i, 'patient_name', e.target.value)} /></td>
                <td><input type="date" value={row.dispensed_date || ''} onChange={e => updateRow(i, 'dispensed_date', e.target.value)} /></td>
                <td><input type="date" value={row.expiry_date || ''} onChange={e => updateRow(i, 'expiry_date', e.target.value)} /></td>
                <td><input value={row.batch_number} onChange={e => updateRow(i, 'batch_number', e.target.value)} /></td>
                <td>
                  <button type="button" className={`tick-toggle ${triClass(row.condition_flag, 'ok')}`}
                    onClick={() => updateRow(i, 'condition_flag', cycleConditionFlag(row.condition_flag))}>
                    {triIcon(row.condition_flag, 'ok')}
                  </button>
                </td>
                <td>
                  <button type="button" className={`tick-toggle ${triClass(row.label_attached, true)}`}
                    onClick={() => updateRow(i, 'label_attached', cycleBool(row.label_attached))}>
                    {triIcon(row.label_attached, true)}
                  </button>
                </td>
                <td>
                  <button type="button" className={`tick-toggle ${triClass(row.sealed, true)}`}
                    onClick={() => updateRow(i, 'sealed', cycleBool(row.sealed))}>
                    {triIcon(row.sealed, true)}
                  </button>
                </td>
                <td>
                  <select value={row.disposition || ''} onChange={e => updateRow(i, 'disposition', e.target.value)}>
                    <option value="">—</option>
                    <option value="reclaim">Reclaim</option>
                    <option value="dispose">Dispose</option>
                  </select>
                </td>
                <td><input value={row.source_clinic} onChange={e => updateRow(i, 'source_clinic', e.target.value)} /></td>
                <td><input value={row.notes} onChange={e => updateRow(i, 'notes', e.target.value)} /></td>
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
