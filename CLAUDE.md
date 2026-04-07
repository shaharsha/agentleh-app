# agentleh-app

Self-serve web app for Agentiko — user onboarding, payment, and agent provisioning.

## Architecture

Monorepo: FastAPI backend serves Vite-built React frontend.

```
app/
├── api/           # FastAPI (auth, onboarding, payment, dashboard)
├── lib/           # Database, config
├── services/      # Provisioning, payment, WhatsApp (mock + real)
├── config/        # Dynaconf settings per environment
├── frontend/      # React 19 + Vite + Tailwind CSS 4
└── tests/
```

## Tech Stack

- **Backend**: Python 3.11, FastAPI, psycopg3, Dynaconf
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4
- **Auth**: Supabase Auth (Google OAuth + email/password), JWT verified backend-side (HS256)
- **Database**: Shared Render PostgreSQL (same DB as bridge)
- **Deployment**: Docker on Render (Frankfurt)

## Environments

| | Dev | Prod |
|---|---|---|
| App | `app-dev.agentiko.io` | `app.agentiko.io` |
| Render | `srv-d7ae8dtm5p6s73evinj0` | `srv-d7af043uibrs739oa8ug` |
| Supabase | `mnetqtjwcdunznvvfaob` | `hizznfloknpqtznywwsj` |
| Branch | `develop` | `main` |

## Running Locally

```bash
uv sync                        # Python deps
cd frontend && npm install     # Frontend deps
cd ..
uv run dev                     # Backend (8000) + frontend (5173)
```

Requires `.env` in `frontend/` with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_LANDING_URL`.
Requires `APP_SUPABASE_JWT_SECRET` and `DATABASE_URL` env vars for backend.

## CI/CD

GitHub Actions: push to `develop` deploys to dev, push to `main` deploys to prod.
Tests (pytest + tsc + vite build) must pass before deploy.
Auto-deploy disabled on Render — CI triggers deploys via API.

## Design System

Shared with landing page (`agentiko-landing` repo). Same CSS classes:
`glass-nav`, `glass-card`, `glass-card-elevated`, `glass-card-hover`, `glass-pill`,
`section-gradient`, `section-gradient-alt`, `section-gradient-hero`,
`btn-brand`, `btn-secondary`, `btn-sm`, `btn-md`, `input-glass`.

All URLs configurable via `VITE_*` env vars. No hardcoded domains in code.
