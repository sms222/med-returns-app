-- Medication Returns Tracker — Supabase schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query)

-- ── Reference tables ────────────────────────────────────────────
create table if not exists hospitals (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists bins (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references hospitals(id) on delete cascade,
  label text not null,           -- e.g. "Bin 1", "Ward 3B Bin"
  unique (hospital_id, label)
);

-- Staff profile, one row per authenticated user, tagged to a home hospital+bin
-- so they never have to pick it again after first setup.
create table if not exists staff_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  hospital_id uuid not null references hospitals(id),
  bin_id uuid not null references bins(id),
  created_at timestamptz not null default now()
);

-- ── Core data ───────────────────────────────────────────────────
create table if not exists bags (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references hospitals(id),
  bin_id uuid not null references bins(id),
  collected_by uuid not null references staff_profiles(id),
  collected_at timestamptz not null default now(),
  photo_url text,                 -- whole-bag photo, Supabase Storage path
  raw_transcript text,            -- original voice transcript, kept for audit/re-parsing
  notes text
);

create table if not exists medications (
  id uuid primary key default gen_random_uuid(),
  bag_id uuid not null references bags(id) on delete cascade,
  drug_name text,
  brand_name text,
  strength text,                  -- e.g. "24 mg"
  pack_type text,                 -- bottle | vial | blister | strip | box | other
  quantity_remaining numeric,     -- unit count left (tablets, mL, etc.)
  manufacturer text,
  patient_mrn text,
  patient_name text,
  dispensed_date date,
  expiry_date date,
  expired_at_return boolean,
  batch_number text,
  box_intact boolean,
  condition_flag text,            -- ok | damaged | exposed | contaminated
  reason_for_return text,
  extra_photo_url text,           -- optional close-up photo
  created_at timestamptz not null default now()
);

create index if not exists idx_bags_hospital on bags(hospital_id);
create index if not exists idx_bags_bin on bags(bin_id);
create index if not exists idx_bags_collected_at on bags(collected_at);
create index if not exists idx_meds_bag on medications(bag_id);
create index if not exists idx_meds_drug_name on medications(drug_name);
create index if not exists idx_meds_expiry on medications(expiry_date);

-- ── Row Level Security ──────────────────────────────────────────
-- Any authenticated staff member can read everything (shared dashboard)
-- and insert their own bags/medications. Adjust if you need stricter rules later.
alter table hospitals enable row level security;
alter table bins enable row level security;
alter table staff_profiles enable row level security;
alter table bags enable row level security;
alter table medications enable row level security;

create policy "read hospitals" on hospitals for select using (auth.role() = 'authenticated');
create policy "read bins" on bins for select using (auth.role() = 'authenticated');

create policy "read own profile" on staff_profiles for select using (auth.uid() = id);
create policy "insert own profile" on staff_profiles for insert with check (auth.uid() = id);
create policy "update own profile" on staff_profiles for update using (auth.uid() = id);

create policy "read all bags" on bags for select using (auth.role() = 'authenticated');
create policy "insert own bags" on bags for insert with check (auth.uid() = collected_by);

create policy "read all medications" on medications for select using (auth.role() = 'authenticated');
create policy "insert medications" on medications for insert with check (
  auth.uid() = (select collected_by from bags where bags.id = bag_id)
);

-- ── Seed the 2 hospitals and 5 bins — EDIT NAMES BEFORE RUNNING ──
insert into hospitals (name) values ('Hospital A'), ('Hospital B')
  on conflict (name) do nothing;

-- Example: 3 bins at Hospital A, 2 at Hospital B — adjust to your real layout
insert into bins (hospital_id, label)
select h.id, b.label from hospitals h
cross join (values ('Bin 1'), ('Bin 2'), ('Bin 3')) as b(label)
where h.name = 'Hospital A'
on conflict do nothing;

insert into bins (hospital_id, label)
select h.id, b.label from hospitals h
cross join (values ('Bin 1'), ('Bin 2')) as b(label)
where h.name = 'Hospital B'
on conflict do nothing;

-- ── Storage bucket for bag photos ────────────────────────────────
-- Run separately if not already created:
-- insert into storage.buckets (id, name, public) values ('bag-photos', 'bag-photos', true);
