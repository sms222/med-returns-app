// Voice pipeline: record → transcribe (Groq Whisper, free) → parse into
// structured medication fields (Groq Llama, free). Falls back to OpenAI
// (paid, better accuracy) only if VITE_USE_OPENAI_FALLBACK=true and a key is set.

const GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY
const OPENAI_KEY = import.meta.env.VITE_OPENAI_API_KEY
const USE_OPENAI_FALLBACK = import.meta.env.VITE_USE_OPENAI_FALLBACK === 'true'

async function transcribeWithGroq(audioBlob) {
  const form = new FormData()
  form.append('file', audioBlob, 'audio.webm')
  form.append('model', 'whisper-large-v3')
  form.append('language', 'en')
  // Nudge the model toward the vocabulary it'll actually hear.
  form.append('prompt', 'Medication return log: drug names, brand names, mg strengths, MRN, batch numbers, expiry dates.')

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

const FIELD_SCHEMA = `{
  "drug_name": string,
  "brand_name": string | null,
  "strength": string | null,
  "pack_type": "bottle" | "vial" | "blister" | "strip" | "box" | "other" | null,
  "quantity_remaining": number | null,
  "manufacturer": string | null,
  "patient_mrn": string | null,
  "patient_name": string | null,
  "dispensed_date": "YYYY-MM-DD" | null,
  "expiry_date": "YYYY-MM-DD" | null,
  "batch_number": string | null,
  "box_intact": boolean | null,
  "condition_flag": "ok" | "damaged" | "exposed" | "contaminated" | null,
  "reason_for_return": string | null
}`

// Uses Groq's free Llama model to turn a free-text transcript into one or
// more structured medication rows (a staff member may describe several
// medications from the same bag in one breath).
export async function parseTranscriptToMedications(transcript) {
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
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            `You extract structured data from a pharmacist's spoken description of ` +
            `returned medication(s) found in one patient bag. Return ONLY valid JSON: ` +
            `{"medications": [${FIELD_SCHEMA}, ...]}. One object per distinct medication ` +
            `mentioned. Leave a field null if not stated — never invent values. ` +
            `Convert spoken dates to YYYY-MM-DD using reasonable assumptions.`,
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
