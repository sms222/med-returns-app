import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { transcribeAudio, parseTranscriptToMedications, fetchKnownDrugNames, speak, parseSingleFieldAnswer, unlockSpeech, stopSpeaking } from '../lib/voice'

const PACK_TYPES = ['tablet', 'capsule', 'bottle', 'vial', 'blister', 'strip', 'ampoule', 'cartridge', 'sachet', 'box', 'other']

// Fields the assistant will proactively ask about if left blank after
// dictation. Order matters — it asks in this sequence. type controls how the
// spoken answer gets interpreted and confirmed back.
// naSafe: true means it's OK to literally store the text "NA" in this field
// when the person says none/not available (safe for free-text DB columns).
// Fields backed by a number/date/enum column stay naSafe: false — saying
// "none" there just marks the field as skipped instead of writing bad data.
const CORE_FIELDS = [
  { key: 'pack_type', type: 'text', naSafe: false, label: 'unit of measure (tablet, capsule, bottle, vial, blister, strip, ampoule, cartridge, sachet, or box)', question: name => `What is the UOM for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'quantity_remaining', type: 'number', naSafe: false, label: 'quantity remaining', question: name => `What is the quantity for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'patient_mrn', type: 'text', naSafe: true, label: 'patient MRN', question: name => `What is the patient's MRN for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'patient_name', type: 'text', naSafe: true, label: 'patient name', question: name => `What is the patient's name for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'dispensed_date', type: 'text', naSafe: false, label: 'dispensed date, formatted YYYY-MM-DD', question: name => `What is the dispensed date for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'expiry_date', type: 'text', naSafe: false, label: 'expiry date, formatted YYYY-MM-DD', question: name => `What is the expiry date for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'batch_number', type: 'text', naSafe: true, label: 'batch or lot number', question: name => `What is the Batch or Lot number for ${name}?`, confirm: v => `Saved as ${v}.` },
  { key: 'condition_flag', type: 'boolean', naSafe: false, label: 'condition — good or not good', question: name => `Condition for ${name} — 1 for good, 2 for not good.`, confirm: v => `Logged as ${v ? 'good' : 'not good'}.`, toStored: v => (v ? 'ok' : 'not_good') },
  { key: 'label_attached', type: 'boolean', naSafe: false, label: 'label attached', question: name => `Label attached for ${name} — 1 for yes, 2 for no.`, confirm: v => `Saved as ${v ? 'yes' : 'no'}.` },
  { key: 'sealed', type: 'boolean', naSafe: false, label: 'sealed', question: name => `Sealed for ${name} — 1 for yes, 2 for no.`, confirm: v => `Saved as ${v ? 'yes' : 'no'}.` },
  { key: 'disposition', type: 'choice', naSafe: false, label: 'action — reclaim or dispose', question: name => `Action for ${name} — 1 for reclaim, 2 for dispose.`, confirm: v => `Saved as ${v}.`, options: [{ num: 1, value: 'reclaim' }, { num: 2, value: 'dispose' }] },
  { key: 'source_clinic', type: 'text', naSafe: true, label: 'source clinic, only if different from this bin\'s usual collection point', question: name => `What is the source clinic for ${name}?`, confirm: v => `Saved as ${v}.` },
]

// Matches a spoken number, accepting common Whisper mishearings
// ("to"/"too" for "two").
function matchesNumber(lower, n) {
  if (n === 1) return /\b1\b|\bone\b/.test(lower)
  if (n === 2) return /\b2\b|\btwo\b|\bto\b|\btoo\b/.test(lower)
  return false
}

// Recognizes "none" / "not available" style answers so they can be
// accepted immediately instead of triggering a re-ask.
const NA_PATTERN = /\b(none|n\s*\/?\s*a|not\s*applicable|not\s*available|nothing)\b/

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

function findNextMissing(rows, skipped = {}) {
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].drug_name?.trim()) continue
    for (const f of CORE_FIELDS) {
      const val = rows[i][f.key]
      const isMissing = val === '' || val === null || val === undefined
      if (isMissing && !skipped[`${i}:${f.key}`]) {
        return { rowIndex: i, field: f.key, question: f.question(rows[i].drug_name), type: f.type, label: f.label, confirm: f.confirm, toStored: f.toStored, naSafe: f.naSafe }
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
  const [skippedFields, setSkippedFields] = useState({}) // `${rowIndex}:${field}` -> true, once answered NA or unclear
  const [speaking, setSpeaking] = useState(false)
  const [hospitals, setHospitals] = useState([])
  const [bins, setBins] = useState([])
  const [hospitalId, setHospitalId] = useState('')
  const [binId, setBinId] = useState('')

  const mediaRecorder = useRef(null)
  const chunks = useRef([])
  const knownDrugsRef = useRef(null)
  const pendingRef = useRef(null)
  const rowsRef = useRef(rows)
  const skippedRef = useRef(skippedFields)
  const silenceWatcherRef = useRef(null)
  const stoppedRef = useRef(false)

  // Keep refs in sync so the recorder's onstop callback — which can end up
  // holding a stale closure across several auto-continue cycles — always
  // reads the latest pending question and rows instead of an old snapshot.
  useEffect(() => { pendingRef.current = pending }, [pending])
  useEffect(() => { rowsRef.current = rows }, [rows])
  useEffect(() => { skippedRef.current = skippedFields }, [skippedFields])

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
  function setSkippedNow(value) {
    skippedRef.current = value
    setSkippedFields(value)
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
    let hasSpoken = false // don't start the silence countdown until real speech is heard

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

      if (rms >= SILENCE_RMS_THRESHOLD) {
        hasSpoken = true
        silenceStartedAt = null
      } else if (hasSpoken && elapsed > MIN_RECORDING_MS) {
        if (silenceStartedAt === null) silenceStartedAt = Date.now()
        if (Date.now() - silenceStartedAt > SILENCE_DURATION_MS) {
          audioCtx.close().catch(() => {})
          stopRecording()
          return
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

  // Appends a labeled line to the visible transcript so it reads as a full
  // conversation log (both what the assistant asked/said and what the
  // person answered), not just the person's side.
  function appendTranscript(speaker, text) {
    if (!text || !text.trim()) return
    setTranscript(prev => (prev ? prev + '\n' : '') + `${speaker}: ${text.trim()}`)
  }

  async function askAboutNextMissing(currentRows, confirmationText) {
    if (stoppedRef.current) return
    if (confirmationText) {
      setStatus(confirmationText)
      appendTranscript('Assistant', confirmationText)
      setSpeaking(true)
      await speak(confirmationText)
      setSpeaking(false)
    }
    if (stoppedRef.current) return
    const next = findNextMissing(currentRows, skippedRef.current)
    setPendingNow(next)
    if (next) {
      setStatus(`Assistant: ${next.question}`)
      appendTranscript('Assistant', next.question)
      setSpeaking(true)
      await speak(next.question)
      setSpeaking(false)
      if (stoppedRef.current) return
      await beginListening(true)
    } else {
      setStatus('Everything looks filled in — ready to save.')
      appendTranscript('Assistant', 'All set — ready to save.')
      setSpeaking(true)
      await speak('All set — ready to save.')
      setSpeaking(false)
    }
  }

  // Interrupts the assistant immediately — stops any TTS mid-sentence and
  // stops/discards any in-progress recording, without asking the next question.
  function stopAssistant() {
    stoppedRef.current = true
    stopSpeaking()
    setSpeaking(false)
    if (recording) stopRecording()
    setPendingNow(null)
    setStatus('Stopped.')
  }

  async function handleRecordingStop() {
    if (stoppedRef.current) {
      setTranscribing(false)
      return
    }
    const blob = new Blob(chunks.current, { type: 'audio/webm' })
    setTranscribing(true)
    const currentPending = pendingRef.current

    // Answering a follow-up question from the assistant.
    if (currentPending) {
      setStatus('Listening for your answer…')
      try {
        const text = await transcribeAudio(blob)
        appendTranscript('You', text)
        const lower = text.toLowerCase().trim()
        const skipKey = `${currentPending.rowIndex}:${currentPending.field}`
        const isNA = NA_PATTERN.test(lower)

        let value = null
        if (!isNA) {
          if (currentPending.type === 'boolean') {
            // Numbered answers only — 1 = yes, 2 = no. No LLM call needed here.
            if (matchesNumber(lower, 1)) value = true
            else if (matchesNumber(lower, 2)) value = false
          } else if (currentPending.type === 'choice') {
            const match = currentPending.options.find(o => matchesNumber(lower, o.num))
            value = match ? match.value : null
          } else {
            const raw = await parseSingleFieldAnswer(currentPending.label ?? currentPending.field, text)
            value = raw && raw.trim() ? raw.trim() : null
          }
        }

        if (isNA || value === null || value === '') {
          // Unanswered/unclear on a field that's safe to hold free text
          // (MRN, patient name, batch/lot, clinic) — write "NA" rather than
          // leaving it silently blank, whether they said "none" or the
          // answer just wasn't understood. One attempt only either way —
          // no re-asking the same question.
          if (currentPending.naSafe) {
            const next = rowsRef.current.map((r, idx) => (idx === currentPending.rowIndex ? { ...r, [currentPending.field]: 'NA' } : r))
            setRowsNow(next)
            await askAboutNextMissing(next, 'Marked as NA.')
          } else {
            setSkippedNow({ ...skippedRef.current, [skipKey]: true })
            await askAboutNextMissing(rowsRef.current, isNA ? 'Marked as not available.' : `Didn't catch that — skipping for now.`)
          }
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
      appendTranscript('You', text)
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
            onClick={() => { if (recording) { stopRecording() } else { stoppedRef.current = false; beginListening() } }}
            disabled={transcribing}
          >
            {recording ? '● Stop' : transcribing ? 'Working…' : pending ? '🎙 Answer' : '🎙 Speak'}
          </button>
          {(speaking || pending) && (
            <button className="mic-btn stop-assistant" onClick={stopAssistant} title="Stop the assistant talking">
              ⏹ Stop
            </button>
          )}
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
