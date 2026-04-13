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
- **Database**: Cloud SQL Postgres 15 at `10.65.0.3` (private IP, shared with bridge; prod = `agentleh_prod`, dev = `agentleh_dev`)
- **Deployment**: Docker on Cloud Run (europe-west3), always-on + `--no-cpu-throttling` for prod, `min-instances=0` for dev

## Environments

| | Dev | Prod |
|---|---|---|
| Public URL | `app-dev.agentiko.io` | `app.agentiko.io` |
| Cloud Run service | `agentleh-app-dev` | `agentleh-app` |
| Supabase | `mnetqtjwcdunznvvfaob` | `hizznfloknpqtznywwsj` |
| Branch | `develop` | `main` |

Both URLs route via the shared Global HTTPS LB at `34.111.24.95` → backend service → serverless NEG → Cloud Run.

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

GitHub Actions (`.github/workflows/deploy.yml`):
1. **Test** — backend pytest + frontend tsc/vite build
2. **Auth** — Workload Identity Federation (no long-lived SA keys)
3. **Build** — `gcloud builds submit --config=cloudbuild.yaml` with environment-specific VITE build args (dev Supabase vs prod Supabase)
4. **Deploy** — `gcloud run deploy` to prod (on `main`) or dev (on `develop`)
5. **Verify** — curl `/health` on the custom hostname

Required GitHub secrets: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

## Secrets at runtime

Cloud Run injects from Google Secret Manager:
- `DATABASE_URL` → Cloud SQL private IP, prod or dev database
- `APP_SUPABASE_JWT_SECRET` → Supabase JWT signing key

Plain env vars: `ENV_FOR_DYNACONF=production` (or `development`).

## Design System

Shared with landing page (`agentiko-landing` repo). Same CSS classes:
`glass-nav`, `glass-card`, `glass-card-elevated`, `glass-card-hover`, `glass-pill`,
`section-gradient`, `section-gradient-alt`, `section-gradient-hero`,
`btn-brand`, `btn-secondary`, `btn-sm`, `btn-md`, `input-glass`.

All URLs configurable via `VITE_*` env vars. No hardcoded domains in code.
