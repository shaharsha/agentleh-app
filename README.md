# agentleh-app

Self-serve web app for [Agentiko](https://agentiko.io) — onboarding, tenant management, coupon-based plan activation, and per-tenant agent provisioning. Bilingual (Hebrew + English).

Part of [Agentleh](https://github.com/shaharsha/agentleh). Operational detail lives in [CLAUDE.md](CLAUDE.md).

## Stack

FastAPI (Python 3.11) backend + React 19 / Vite / Tailwind 4 SPA in a single Docker image. Supabase Auth (Google OAuth + email/password) with **ES256 JWT** verification via JWKS. Cloud SQL Postgres 15 (private IP) shared with the bridge + meter. Deployed to Cloud Run (europe-west3).

## Environments

| | URL | Branch | Cloud Run service |
|---|---|---|---|
| Prod | [app.agentiko.io](https://app.agentiko.io) | `main` | `agentleh-app` |
| Dev | [app-dev.agentiko.io](https://app-dev.agentiko.io) | `develop` | `agentleh-app-dev` |

Both routed via the shared Global HTTPS LB (`34.111.24.95`).

## Running locally

```bash
uv sync                                 # Python
cd frontend && npm install && cd ..     # Frontend
uv run dev                              # Backend (8000) + frontend (5173)
```

`frontend/.env` needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_LANDING_URL`. Backend needs `DATABASE_URL`, `APP_METER_BASE_URL`, `APP_METER_ADMIN_TOKEN`, `RESEND_API_KEY`, and by default `AGENTLEH_PROVISIONER=mock` (use `vm` against a real VM).

## Deploy

GitHub Actions + Workload Identity Federation. Push to `develop` → dev. Merge to `main` → prod. See [CLAUDE.md](CLAUDE.md) for the full secret/env injection map.

## License

Private.
