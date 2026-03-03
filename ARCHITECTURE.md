Microgrid v0 Spec — Vite + TypeScript + Raw WebGPU + Supabase

Goal: a browser app that renders 10k–50k “data atoms” (tasks/dates/messages/images/whatever) as GPU-instanced tiles at 60fps, with pan/zoom, hover/select, deterministic layout that morphs on resize, and Supabase realtime updates.

1) Scope (v0)
Must ship

WebGPU-only renderer (no WebGL fallback in v0)

One unified Atom model for all data types

Instanced tile rendering (single pipeline, single draw call per frame)

Pan + zoom camera

Hover + select (CPU spatial hash picking)

Deterministic layout + smooth morph on resize

Supabase: atoms table + realtime subscription + basic RLS

Inspector side panel (DOM) for selected atom

Explicitly out of scope (v0)

Real packing/occupancy for large tiles (2×2 actually taking space)

Text inside tiles

GPU picking (offscreen ID buffer)

GPU clustering/LOD compute

Multiple workspaces/teams (optional in v0)

2) Tech stack

Vite + TypeScript

Raw WebGPU API (no engine)

Minimal math helper (either your own or gl-matrix if you want)

Supabase JS client (@supabase/supabase-js)

Optional: Zustand for state (or plain module store)

3) Repository layout
/src
  /app
    main.tsx                 // React shell + canvas + inspector
    store.ts                 // Atom store + selection + filters
  /gpu
    gpu.ts                   // device/context init
    pipeline.ts              // pipeline + bindgroups
    buffers.ts               // buffer creation + updates
    shaders.wgsl             // vertex+fragment WGSL
    renderer.ts              // render loop, camera, uniforms
  /layout
    layout.ts                // deterministic slot assignment + targets
    spatialHash.ts           // CPU picking accel
  /data
    supabase.ts              // client init
    sync.ts                  // initial load + realtime subscription
    types.ts                 // Atom types, enums

4) Data model (frontend)
Atom (in-memory)
type AtomType = "task" | "date" | "message" | "email" | "image" | "file" | "event" | "custom";
type AtomState = "new" | "active" | "snoozed" | "done" | "archived";

type Atom = {
  id: string;
  type: AtomType;
  ts: number;           // ms since epoch
  due?: number;         // ms since epoch (optional)
  urgency: number;      // 0..1
  importance: number;   // 0..1
  state: AtomState;

  title?: string;       // inspector only
  preview?: string;     // inspector only
  payload?: any;        // json blob

  // Derived/cached fields used for layout/render:
  score: number;        // computed
  stableKey: number;    // hash(id) as uint32
  sizeTier: 0|1|2;      // 0=1x,1=2x,2=3x (visual only in v0)

  // Layout:
  targetX: number;      // world space
  targetY: number;
};

Score (v0)

Compute on each update:

recency = clamp(1 - (now - ts)/RECENCY_HALF_LIFE, 0..1) (or exponential)

score = 0.55*urgency + 0.35*importance + 0.10*recency

sizeTier = score > 0.85 ? 2 : score > 0.65 ? 1 : 0

5) Supabase schema (backend)
Table: atoms

SQL:

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

RLS
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

Realtime

Enable realtime on public.atoms. Client subscribes to postgres_changes filtered by user_id.

6) Rendering model (WebGPU)
Coordinate systems

World space: continuous plane where tiles live.

Screen space: canvas pixels.

Camera transforms world → NDC.

Camera params

camX, camY world center

zoom (world units to screen scale)

7) GPU buffer layout (v0)
7.1 Instance data (one per tile)

We want compact + aligned.

Instance struct (WGSL)

struct Instance {
  pos     : vec2f,   // world center
  size    : f32,     // base tile size * tier scalar
  z       : f32,     // urgency lift 0..1 (visual)
  color   : u32,     // packed RGBA8
  flags   : u32,     // bits: type, selected, hovered, pulsing
  t0      : f32,     // created/updated time (seconds)
  due     : f32,     // due time (seconds) or -1
  _pad    : f32,
};


CPU backing buffer

Use a single ArrayBuffer with Float32Array + Uint32Array views.

Stride = 32 bytes or 48 bytes depending on padding. Prefer 48 bytes for alignment sanity.

Why pack color to u32

Saves bandwidth

Decode in shader

flags layout (u32)

bits 0..3: typeId (0..15)

bit 4: selected

bit 5: hovered

bit 6: pulsing

bit 7: archived/dim

rest reserved

7.2 Uniforms

GlobalUniforms

struct Globals {
  viewProj : mat3x3f;  // 2D affine in 3x3
  now      : f32;      // seconds
  baseSize : f32;      // base tile size in world units
  pixelRatio : f32;
  zoom     : f32;
  hoveredId : u32;     // optional (or keep in flags buffer updates)
  selectedId : u32;
};


Bind group 0:

uniform buffer (Globals)

Bind group 1:

storage buffer (Instances)

8) Pipeline + shaders (WGSL responsibilities)
Vertex shader

Input: vertex_index for a unit quad (6 vertices) + instance_index

Steps:

Load instance

Build quad corners in local space:

(-0.5,-0.5) ... (0.5,0.5) * instance.size

Add instance.pos to get world pos

Multiply by viewProj to get clip coords

Pass to fragment:

localUV (0..1)

instance.color

flags

age = now - t0

dueDelta = due - now

Fragment shader

Draw a crisp square tile with a few effects:

Base fill from color

Age decay:

fade = exp(-age / DECAY) or clamp curve

dim + desaturate as age grows

Urgency pulse:

if pulsing: pulse = 0.5 + 0.5*sin(now*PULSE_RATE)

apply slight brightness modulation (don’t glow like a nightclub)

Selection/hover outline:

edge test from localUV

1–2px outline in screen space (approx ok in v0)

Elevation fake:

subtle shadow offset based on z (cheap: darken one edge)

Rule: effects must be subtle. The grid should read as signal, not fireworks.

9) Layout system (deterministic + morph)
9.1 Logical slots

Given N atoms and viewport, define a logical grid:

cols = floor(viewportWorldWidth / slotSpacing)

rows = ceil(N / cols)

Slot spacing:

slotSpacing = baseSize * 1.15 (small gutter)

Assign slot index in stable order:

sort by (score desc, ts desc, stableKey asc)

slot i → (sx = i % cols, sy = floor(i / cols))

map to world:

targetX = (sx - cols/2) * slotSpacing

targetY = -(sy) * slotSpacing

9.2 Morphing

We want smooth movement without storing full physics per tile on CPU.

v0 approach: do easing on CPU each frame:

pos = lerp(pos, target, 1 - exp(-dt*k))

k around 12–18

That means:

CPU updates instance positions in the buffer per frame.

For 10k tiles this is fine.

(You can later move this to GPU by storing both pos and target and doing easing in shader, but keep v0 dead simple.)

9.3 Resize behavior

On resize:

recompute cols

recompute targets

tiles flow to new targets (positions update over several frames)

Hard rule: no random shuffling. Stability matters more than optimal packing.

10) Picking (CPU spatial hash)
10.1 Spatial hash grid

Cell size = slotSpacing (or baseSize*2)

Build map each time you recompute layout targets OR every few frames.

Key:

cellKey = (cx << 16) | cy (or string key)

Value:

list of tile indices in that cell

10.2 Hover

On mouse move:

screen → world (invert camera transform)

compute cell coordinate

check candidates:

point-in-rect with tile size

set hovered index

Update hovered state:

Either patch flags for that one instance, or store hoveredId uniform and compare instanceIndex in shader.

v0 easiest: patch flags for hovered and previously hovered.

11) Supabase sync (initial + realtime)
11.1 Initial load

Query:

select * from atoms where user_id = auth.uid() and state != 'archived' order by ts desc limit 5000
(v0 cap is fine; you can page later)

11.2 Realtime subscription

Subscribe to:

INSERT / UPDATE / DELETE on atoms

Filter by user_id

Client behavior:

INSERT: add Atom, compute score/tier, append to store

UPDATE: patch Atom, recompute derived fields, mark layout dirty

DELETE: remove Atom

Batching rule:

Rebuild layout at most once per animation frame (or with a 50–100ms debounce if you’re getting spammed).

12) Performance targets & budgets (v0)

10k tiles: 60fps on a decent laptop GPU

50k tiles: should still feel responsive (hover may degrade first)

CPU per-frame work:

position easing: O(N)

hover test: O(k) candidates

GPU:

1 pipeline, 1 draw call: draw(6, instanceCount)

If perf is bad:

reduce effects

reduce per-frame CPU updates by moving easing to shader (v1)

add LOD (v1)

13) v0 UI (React shell)

Fullscreen canvas

Right-side inspector panel:

type, title, preview, timestamps, urgency/importance sliders (optional)

Top bar:

filter chips by type/state

search (filters atom set, doesn’t alter source of truth)

Bottom-left debug:

FPS, tile count, hovered id

14) Implementation order (do it exactly like this)

WebGPU init + clear screen

Draw instanced quads (random data, 20k)

Camera pan/zoom

CPU layout targets + easing movement

Spatial hash hover + selection outline

Supabase: read atoms → render real data

Supabase realtime → live updates

Polish: decay + subtle pulse + focus mode (dim non-selected cluster)

15) v1 hooks (so you don’t regret v0)

Design choices to preserve:

Keep Atom → Instance packing in one place (buffers.ts)

Keep layout logic pure (layout.ts)

Keep renderer stateless-ish: it just consumes instance arrays

Never bake “task/email/image” logic into the GPU — only into encoding (typeId/color/flags)

If you want, next message I can drop:

exact Globals + Instance byte offsets (so your TS packing matches WGSL perfectly)

the deterministic stable hash (fast uint32)

the camera math (mat3) + screen→world inversion

a minimal Supabase sync.ts that batches updates cleanly