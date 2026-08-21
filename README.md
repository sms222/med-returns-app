# Med Returns Tracker

A web app for logging medications returned to hospital collection bins —
voice-first data entry, one photo per bag, and a live dashboard. Works on
Mac, Windows, iPhone and Android as an installable PWA (add to home screen),
no app-store build needed.

**Stack — all free to run at your scale:**
- **Frontend:** React + Vite, deployed free on Vercel or Netlify
- **Backend:** Supabase (free tier) — Postgres database, file storage, auth
- **Voice:** Groq's free Whisper API for transcription + free Llama model to
  parse the transcript into structured fields. An optional paid OpenAI
  fallback can be switched on later if accuracy needs a boost.

## 1. Set up Supabase (free)

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. Go to **SQL Editor** → paste in `supabase/schema.sql` → run it.
   - Edit the hospital names and bin labels near the bottom of that file
     first if "Hospital A/B" and "Bin 1/2/3" don't match your real setup —
     or just run it as-is and rename them later in the Table Editor.
3. Go to **Storage** → create a new bucket named `bag-photos`, set it to
   **public** (or run the commented-out `insert into storage.buckets…`
   line at the bottom of `schema.sql`).
4. Go to **Project Settings → API** and copy the **Project URL** and
   **anon public key**.

## 2. Set up Groq (free)

1. Create a free account at [console.groq.com](https://console.groq.com).
2. Go to **API Keys** → create a key. No credit card required.
   Free tier covers 2,000 requests/day — far more than 5 bins need daily.

## 3. Configure the app

```
cp .env.example .env
```

Fill in `.env` with your Supabase URL/key and Groq key.

## 4. Run locally

```
npm install
npm run dev
```

Open the printed local URL. Sign up with an email/password, then the
one-time setup screen asks each staff member to pick their name, hospital,
and bin — that's tagged to their account permanently, so nobody re-selects
it again.

## 5. Deploy for free

**Vercel** (recommended, simplest):
```
npm i -g vercel
vercel
```
Add the same `.env` values under the project's **Environment Variables**
in the Vercel dashboard, then redeploy.

**Netlify** works the same way — connect the repo, set the build command
to `npm run build`, publish directory `dist`, and add the env vars.

Either gives you a free `https://` URL. On iPhone/Android, staff open it in
the browser and tap **Share → Add to Home Screen** to get an app-like icon
with no browser chrome — that's the PWA install, no App Store needed.

## How it works day to day

1. Staff sign in once — the app already knows their hospital and bin.
2. For each returned bag: tap **🎙 Speak** and describe what's in the bag
   naturally (drug name, strength, MRN, patient name, dispensed date,
   condition, expiry, batch number, etc.). Multiple medications in one bag
   can all be described in the same recording.
3. The transcript is parsed automatically into an editable, spreadsheet-
   style row per medication — staff just glance over it and fix anything
   the voice model got wrong.
4. Snap one photo of the whole bag (optional close-ups per item too).
5. Tap **Save bag** — it's in Supabase, and the dashboard on the right
   updates immediately: bags logged, top returned drugs, expired-at-return
   rate, split by hospital, condition on return.

## Upgrading voice accuracy later

If Groq's free Whisper occasionally mishears drug names, set
`VITE_USE_OPENAI_FALLBACK=true` and add `VITE_OPENAI_API_KEY` in `.env` —
OpenAI's transcription runs a close second in cost (roughly $0.005–0.006
per minute of audio) with typically better accuracy on medical vocabulary.
Groq stays the default; OpenAI only kicks in if you flip that switch.

## Notes / next steps

- Row Level Security is set up so any signed-in staff member can read all
  bags/medications (for the shared dashboard) but can only insert bags
  under their own account — tighten this further in `supabase/schema.sql`
  if you need per-hospital restrictions.
- The medication table's `condition_flag`, `pack_type`, and `reason_for_return`
  are free text/enums — easy to extend with more options as you see real
  usage patterns.
- No backend server is required — the browser talks to Supabase and Groq
  directly, which is why hosting stays free.
