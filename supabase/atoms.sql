create table if not exists public.atoms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  type text not null,
  state text not null default 'active',
  ts timestamptz not null default now(),
  due timestamptz,
  urgency real not null default 0,
  importance real not null default 0,
  title text,
  preview text,
  payload jsonb not null default '{}'::jsonb,
  source text not null default 'manual',
  dedupe_key text
);

create index if not exists atoms_user_ts_idx on public.atoms(user_id, ts desc);
create index if not exists atoms_user_state_idx on public.atoms(user_id, state);
create unique index if not exists atoms_user_dedupe_idx
  on public.atoms(user_id, dedupe_key)
  where dedupe_key is not null;

alter table public.atoms enable row level security;

create policy "read own atoms"
on public.atoms for select
using (auth.uid() = user_id);

create policy "write own atoms"
on public.atoms for insert
with check (auth.uid() = user_id);

create policy "update own atoms"
on public.atoms for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "delete own atoms"
on public.atoms for delete
using (auth.uid() = user_id);

create table if not exists public.logogram_dictionary (
  id uuid primary key default gen_random_uuid(),
  phrase text not null unique,
  canonical_key text not null unique,
  segment_mask int not null,
  style jsonb not null default '{}'::jsonb,
  language text not null default 'heptapod_b_v1',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists logogram_dictionary_phrase_idx on public.logogram_dictionary(phrase);
create unique index if not exists logogram_dictionary_key_idx on public.logogram_dictionary(canonical_key);

alter table public.logogram_dictionary enable row level security;

create policy "read logogram dictionary"
on public.logogram_dictionary for select
using (auth.role() = 'authenticated');
