# Ceramic

GPU-first fluid logogram viewer using React, TypeScript, WebGPU, and a local Node + SQLite backend.

## Stack

- Vite
- React + TypeScript
- WebGPU (no WebGL fallback)
- Node + Express
- SQLite

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local` from `.env.example` and set:

```env
VITE_API_BASE_URL=http://localhost:8787
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
PORT=8787
DB_PATH=./data/ceramic.db
```

3. Run frontend and backend together:

```bash
npm run dev:all
```

4. Build and type-check:

```bash
npm run typecheck
npm run build
```

## Local API

- `GET /api/health`
- `GET /api/atoms?limit=5000`
- `GET /api/dictionary?language=heptapod_b_v1&limit=200`
- `POST /api/messages/generate`
- `GET /api/events` (SSE)

## Notes

- Database file is local (`DB_PATH`), default `./data/ceramic.db`.
- Dictionary is seeded automatically on server startup (100 entries) if empty.
- OpenAI calls happen server-side only.

## Privacy and Repo Hygiene

- No keys or tokens are committed.
- Local environment files are gitignored.
- Keep secrets only in `.env.local`.
