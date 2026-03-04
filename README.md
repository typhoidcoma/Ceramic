# Ceramic

GPU-first microgrid viewer for high-volume atom data using React, TypeScript, raw WebGPU, and Supabase realtime.

## Stack

- Vite
- React + TypeScript
- WebGPU (no WebGL fallback in v0)
- Supabase JS client

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` from `.env.example` and set:

```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
VITE_SUPABASE_LLM_FUNCTION_NAME=super-service
```

3. Run the app:

```bash
npm run dev
```

4. Build and type-check:

```bash
npm run typecheck
npm run build
```

## Supabase Setup

1. Run SQL from `supabase/atoms.sql` in your Supabase project.
2. Enable Realtime for `public.atoms`.
3. Enable Email auth provider for OTP sign in.
4. Set local development URL in Supabase auth settings.
5. Deploy the Edge Function:

```bash
supabase functions deploy super-service
```

6. Set function secret in Supabase project:

```bash
supabase secrets set OPENAI_API_KEY=your_openai_api_key
```

If your deployed function uses a different name, set `VITE_SUPABASE_LLM_FUNCTION_NAME` accordingly.

## Privacy and Repo Hygiene

- No personal keys or tokens are committed.
- Local environment files are gitignored.
- Use `.env.local` for machine-specific credentials.

## Suggested First Commit

```bash
git add .
git commit -m "Initial project scaffold"
```
