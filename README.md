# agentleh-app

Self-serve web app for [Agentiko](https://agentiko.io) — user onboarding, payment, and agent provisioning.

Part of [Agentleh](https://github.com/shaharsha/agentleh).

## How It Works

```
Browser ←→ Cloudflare DNS ←→ Global HTTPS LB ←→ Cloud Run agentleh-app
                                                       ↑           ↑
                                               Supabase Auth   Cloud SQL
                                                (Google OAuth) (private IP)
```

1. React 19 + Vite SPA served from a FastAPI backend (single Docker image)
2. Users sign in via Supabase Auth (Google OAuth or email/password)
3. Backend verifies Supabase JWT (HS256) on every `/api/*` call
4. Shared Cloud SQL Postgres 18 with the bridge (same `agents` / `phone_routes` tables)

## Stack

- **Backend**: Python 3.11, FastAPI, psycopg3, Dynaconf
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4 (Liquid Glass design system)
- **Auth**: Supabase Auth (Google OAuth + email/password), JWT verified backend-side (HS256)
- **Database**: Cloud SQL Postgres 18 at `10.65.0.3` (private IP)
- **Deployment**: Docker on Cloud Run (europe-west3), always-on `--no-cpu-throttling` prod, `min-instances=0` dev

## Repo Layout

```
app/
├── api/           # FastAPI routes (auth, onboarding, payment, dashboard)
├── lib/           # Database, config
├── services/      # Provisioning, payment, WhatsApp (mock + real)
├── config/        # Dynaconf settings per environment
├── frontend/      # React 19 + Vite SPA
├── tests/
├── Dockerfile     # Multi-stage Python + Node build
└── cloudbuild.yaml
```

## Environments

| | URL | Branch | Cloud Run service | Supabase |
|---|---|---|---|---|
| Prod | [app.agentiko.io](https://app.agentiko.io) | `main` | `agentleh-app` | `hizznfloknpqtznywwsj` |
| Dev | [app-dev.agentiko.io](https://app-dev.agentiko.io) | `develop` | `agentleh-app-dev` | `mnetqtjwcdunznvvfaob` |

Both routed via the shared Global HTTPS LB (`34.111.24.95`) with Google-managed TLS.

## Running Locally

```bash
uv sync                           # Python backend deps
cd frontend && npm install && cd ..
uv run dev                        # Backend (8000) + frontend (5173)
```

`frontend/.env`:
```env
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_LANDING_URL=https://agentiko.io
```

Backend env:
```env
DATABASE_URL=postgresql://...
APP_SUPABASE_JWT_SECRET=...
```

## Deploy

GitHub Actions CI/CD with Workload Identity Federation:
1. Backend `pytest` + frontend `tsc -b` + `vite build`
2. `gcloud builds submit --config=cloudbuild.yaml` — environment-specific VITE build args
3. `gcloud run deploy` to prod (on `main`) or dev (on `develop`)
4. Health check `/health`

Required GitHub secrets: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

## License

Private.
