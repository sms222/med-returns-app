// Voice pipeline: record → transcribe (Groq Whisper, free) → parse into
// structured medication fields (Groq Llama, free). Falls back to OpenAI
// (paid, better accuracy) only if VITE_USE_OPENAI_FALLBACK=true and a key is set.

import { supabase } from './supabase'

const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY
const OPENAI_KEY = import.meta.env.VITE_OPENAI_API_KEY
const USE_OPENAI_FALLBACK = import.meta.env.VITE_USE_OPENAI_FALLBACK === 'true'

async function transcribeWithGroq(audioBlob) {
  const form = new FormData()
  form.append('file', audioBlob, 'audio.webm')
  form.append('model', 'whisper-large-v3')
  form.append('language', 'en')
  // Nudge the model toward the vocabulary it'll actually hear. Explicitly
  // spelling out "lot number" here matters — without it Whisper tends to
  // mishear staff saying "lot number" as "log number".
  form.append('prompt', 'Medication return log: drug names, brand names, mg strengths, patient MRN, patient name, dispensed date, expiry date, lot number, batch number, quantity remaining, condition, label attached, sealed.')

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Groq transcription failed: ${res.status}`)
  const data = await res.json()
  return data.text
}

async function transcribeWithOpenAI(audioBlob) {
  const form = new FormData()
  form.append('file', audioBlob, 'audio.webm')
  form.append('model', 'gpt-4o-transcribe')
  form.append('prompt', 'Medication return log: drug names, brand names, mg strengths, MRN, batch numbers, expiry dates.')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  })
  if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status}`)
  const data = await res.json()
  return data.text
}

export async function transcribeAudio(audioBlob) {
  if (GROQ_KEY) {
    try {
      return await transcribeWithGroq(audioBlob)
    } catch (err) {
      console.warn('Groq transcription failed, trying OpenAI fallback if enabled', err)
    }
  }
  if (USE_OPENAI_FALLBACK && OPENAI_KEY) {
    return await transcribeWithOpenAI(audioBlob)
  }
  throw new Error('No transcription provider available. Set VITE_GROQ_API_KEY (free) in .env.')
}

// Pulls the distinct drug/brand names already logged in this system, so the
// parser can correct near-miss transcriptions against real medications your
// team has actually seen before, instead of guessing spelling from scratch.
export async function fetchKnownDrugNames() {
  const { data } = await supabase
    .from('medications')
    .select('drug_name, brand_name')
    .not('drug_name', 'is', null)
    .limit(1000)
  if (!data) return []
  const names = new Set()
  for (const row of data) {
    if (row.drug_name) names.add(row.drug_name.trim())
    if (row.brand_name) names.add(row.brand_name.trim())
  }
  return [...names].slice(0, 300)
}

const FIELD_SCHEMA = `{
  "drug_name": string,
  "brand_name": string | null,
  "pack_type": "tablet" | "capsule" | "bottle" | "vial" | "blister" | "strip" | "ampoule" | "cartridge" | "sachet" | "box" | "other" | null,
  "quantity_remaining": number | null,
  "patient_mrn": string | null,
  "patient_name": string | null,
  "dispensed_date": "YYYY-MM-DD" | null,
  "expiry_date": "YYYY-MM-DD" | null,
  "batch_number": string | null,
  "condition_flag": "ok" | "damaged" | "exposed" | "contaminated" | null,
  "label_attached": boolean | null,
  "sealed": boolean | null,
  "disposition": "reclaim" | "dispose" | null,
  "source_clinic": string | null,
  "notes": string | null
}`

// Uses Groq's free Llama model to turn a free-text transcript into one or
// more structured medication rows (a staff member may describe several
// medications from the same bag in one breath). knownDrugs, if given, helps
// the model correct near-miss transcriptions against real medications this
// team has already logged.
export async function parseTranscriptToMedications(transcript, knownDrugs = []) {
  if (!GROQ_KEY) throw new Error('VITE_GROQ_API_KEY is required for parsing.')

  const knownDrugsNote = knownDrugs.length
    ? `\n\nMedications previously logged in this system (correct likely mishearings ` +
      `in the transcript to match one of these when it's clearly the same drug, ` +
      `but never force a match that isn't actually a good fit): ${knownDrugs.join(', ')}.`
    : ''

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `You extract structured data from a pharmacist's spoken description of ` +
            `returned medication(s) found in one patient bag. Return ONLY valid JSON: ` +
            `{"medications": [${FIELD_SCHEMA}, ...]}. One object per distinct medication ` +
            `mentioned. Leave a field null if not stated — never invent values. ` +
            `Convert spoken dates to YYYY-MM-DD using reasonable assumptions. ` +
            `IMPORTANT: quantity_remaining is ONLY the bare number of units left. ` +
            `pack_type is the unit of measure describing what that number counts (tablet, ` +
            `capsule, bottle, vial, blister, strip, ampoule, cartridge, sachet, box). For ` +
            `example "28 tablets" means quantity_remaining: 28, pack_type: "tablet". "2 strips" ` +
            `means quantity_remaining: 2, pack_type: "strip". Never combine the number and unit ` +
            `into one field. drug_name should include the strength/dose as part of the name ` +
            `text itself (e.g. "Betahistine 24mg"), not as a separate field. label_attached and ` +
            `sealed are true/false if the person clearly says whether a label or seal is present; ` +
            `leave null if not mentioned. disposition is "reclaim" if the medication will be put ` +
            `back into stock/use, "dispose" if it will be destroyed/wasted — only set if stated. ` +
            `source_clinic is only for a clinic or location different from where this bin normally ` +
            `collects, if mentioned. Staff may say "lot number" — treat this the same as batch_number. ` +
            `Put any detail mentioned that doesn't fit another field into "notes".` +
            knownDrugsNote,
        },
        { role: 'user', content: transcript },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Groq parsing failed: ${res.status}`)
  const data = await res.json()
  const parsed = JSON.parse(data.choices[0].message.content)
  return parsed.medications ?? []
}

// ── Text-to-speech (browser built-in, free) ──────────────────────────
let cachedVoices = []
function loadVoices() {
  return new Promise(resolve => {
    const existing = window.speechSynthesis?.getVoices() ?? []
    if (existing.length) return resolve(existing)
    window.speechSynthesis.onvoiceschanged = () => resolve(window.speechSynthesis.getVoices())
    // Fallback in case the event never fires on this browser.
    setTimeout(() => resolve(window.speechSynthesis?.getVoices() ?? []), 500)
  })
}

function pickSoftFemaleVoice(voices) {
  const byName = name => voices.find(v => v.name.toLowerCase().includes(name))
  return (
    byName('samantha') || byName('victoria') || byName('karen') || byName('moira') ||
    byName('zira') || byName('susan') || byName('joanna') || byName('salli') ||
    voices.find(v => /female/i.test(v.name)) ||
    voices.find(v => v.lang?.startsWith('en')) ||
    voices[0]
  )
}

// Some mobile browsers (notably iOS Safari) only allow speechSynthesis to
// actually produce sound if it's "unlocked" by a call made directly inside a
// user tap/click — a later speak() call from an async response can otherwise
// fail completely silently. Call this synchronously from the mic button's
// own click handler before doing anything async.
export function unlockSpeech() {
  if (!('speechSynthesis' in window)) return
  try {
    const unlock = new SpeechSynthesisUtterance(' ')
    unlock.volume = 0
    window.speechSynthesis.speak(unlock)
  } catch { /* best effort */ }
}

// Speaks text aloud using the browser's built-in voice engine (no API cost).
// Picks the softest-sounding female voice available on this device and
// speaks at a gentle pace and pitch.
export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}

export async function speak(text) {
  if (!('speechSynthesis' in window)) return
  if (!cachedVoices.length) cachedVoices = await loadVoices()
  window.speechSynthesis.cancel()
  // Small delay avoids a known Chrome/Android bug where speak() called
  // immediately after cancel() is silently dropped.
  await new Promise(r => setTimeout(r, 60))
  const utterance = new SpeechSynthesisUtterance(text)
  const voice = pickSoftFemaleVoice(cachedVoices)
  if (voice) utterance.voice = voice
  utterance.rate = 1.15
  utterance.pitch = 1.05
  utterance.volume = 0.9
  return new Promise(resolve => {
    utterance.onend = resolve
    utterance.onerror = resolve
    window.speechSynthesis.speak(utterance)
  })
}

// Extracts just one field's value from a short spoken answer, used by the
// conversational "ask what's missing" mode. Returns a plain string (or '').
export async function parseSingleFieldAnswer(fieldLabel, transcript) {
  if (!GROQ_KEY) throw new Error('VITE_GROQ_API_KEY is required for parsing.')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            `Extract only the value for "${fieldLabel}" from the person's short spoken answer. ` +
            `Reply with ONLY the value as plain text, nothing else — no labels, no punctuation ` +
            `around it. If it's a date, format as YYYY-MM-DD. If the answer doesn't actually ` +
            `contain this value, reply with an empty string.`,
        },
        { role: 'user', content: transcript },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Groq parsing failed: ${res.status}`)
  const data = await res.json()
  return (data.choices[0].message.content ?? '').trim()
}
