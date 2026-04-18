# agentleh-app

Self-serve web app for Agentiko — user onboarding, tenant management, coupon-based plan activation, and per-tenant agent provisioning. Bilingual (Hebrew-first, English opt-in) with full RTL/LTR support.

Architecture overview, tenant model, and the meter/provisioning contracts live in the parent [CLAUDE.md](../CLAUDE.md) — read that first.

## Architecture

Monorepo: FastAPI backend serves a Vite-built React frontend.

```
app/
├── api/
│   ├── deps.py              # get_current_user (ES256 JWKS), get_active_tenant_member, require_tenant_role
│   ├── main.py              # FastAPI app factory + router wiring
│   └── routes/
│       ├── auth.py          # /auth/me — JWT → app_users upsert + tenants list
│       ├── onboarding.py    # /onboarding/submit — provision first agent
│       ├── coupons.py       # /coupons/preview + /coupons/redeem
│       ├── tenants.py       # /tenants/{id}/... — CRUD + members + agents + provision stream
│       ├── invites.py       # /invites/accept + /invites/preview (unscoped)
│       ├── admin.py         # /admin/* — superadmin-only
│       ├── dashboard.py     # /dashboard/tenants/{id} — tenant-scoped dashboard + usage
│       ├── google_oauth.py  # /oauth/google/* — per-agent Gmail/Calendar connect
│       ├── integrations.py  # /integrations/* — generic provider panel
│       └── voices.py        # /voices/manifest + /voices/pick
├── lib/
│   ├── db.py                # psycopg3 helpers (tenants, memberships, invites, coupons, admin)
│   ├── coupons.py           # redeem() — append-only supersession logic with row locks
│   └── config.py            # Dynaconf settings
├── services/
│   ├── provisioning.py      # AgentProvisioner protocol + MockProvisioner + VmHttpProvisioner
│   ├── meter_client.py      # HTTP shim for /admin/* on the meter
│   ├── email.py             # Resend wrapper (invite emails from noreply@agentiko.io)
│   ├── shortlink.py         # /c/{code} WhatsApp connect shortlinks (base62, 15-min TTL)
│   ├── google_oauth.py      # Google OAuth code → refresh_token → meter handoff
│   └── whatsapp.py          # Welcome template + template catalog
├── config/                  # Dynaconf settings per environment
├── frontend/                # React 19 + Vite + Tailwind CSS 4
└── tests/                   # pytest (74 tests, sub-second)
```

## Tech Stack

- **Backend**: Python 3.11, FastAPI, psycopg3 (sync), Dynaconf, httpx
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4
- **Auth**: Supabase Auth (Google OAuth + email/password). JWTs are **ES256** and verified via JWKS from `<supabase>/auth/v1/.well-known/jwks.json` ([app/api/auth.py](api/auth.py)). Supabase rotated to per-project JWT Signing Keys (ES256 via JWKS) in late 2025; legacy HS256 is no longer in use. JWKS cached in-process with ~1 h TTL.
- **Database**: Cloud SQL Postgres 15 at `10.65.0.3` (private IP, shared with bridge + meter). Migrations owned by the meter repo (`meter/migrations/`).
- **Deployment**: Docker on Cloud Run (europe-west3), always-on + `--no-cpu-throttling` for prod, `min-instances=0` for dev

## Tenant model in this app

See parent [CLAUDE.md](../CLAUDE.md) for the full data model. App-specific implementation:

Every state-changing tenant route goes through `get_active_tenant_member` → `require_tenant_role('owner'|'admin'|'member')`. Non-members get **404** (not 403) so email enumeration via probe attacks leaks nothing. Superadmins bypass membership but still pass through the resolver so downstream code always has a `TenantContext`.

### Onboarding state machine

Three states on `app_users.onboarding_status`:

- `pending` — no plan, no agent. Landing route returns the Redeem Coupon page.
- `plan_active` — coupon redeemed, subscription active, but no agent yet. Onboarding form is surfaced.
- `complete` — at least one agent provisioned. Tenant dashboard is the home.

Gates are on the backend: `POST /onboarding/submit` returns `402 no_active_subscription` if called from `pending`. The frontend polls `/auth/me` to route by state.

Phone is **optional** on the onboarding form — matches the standalone tenant agent-create flow. When omitted, the agent is provisioned without a WhatsApp binding and the user can connect one later from the Bridges panel; the welcome-template send is skipped and the progress bar ends at step 4/4 instead of 5/5.

`/onboarding/submit` is a `StreamingResponse` that forwards NDJSON progress events (`{type, step, total, label}`) from the provisioner's `provision_stream`. Shape matches `/tenants/{id}/agents` so both flows share the same frontend reader. `onboarding_status='complete'` is only flipped after the stream emits a successful `result`, so a mid-stream failure leaves the user in `plan_active` (re-tryable) instead of "complete but no agent."

### Coupon-based plan activation

Plans are activated exclusively by redeeming a coupon ([app/lib/coupons.py](lib/coupons.py)). Two callers:

- Users: `POST /coupons/redeem {code, tenant_id}` (30 req/min/user rate limit)
- Superadmin direct-grants: `POST /admin/tenants/{id}/grant-plan` (logged with `coupon_id=NULL`)

Both converge on `coupons.redeem()`:

1. `SELECT FOR UPDATE` on the coupon row + the tenant's most-recent active sub
2. Computes supersession schedule (immediate upgrade / queued downgrade / queued same-plan renewal). Renewal/downgrade `period_start` chains off `MAX(period_end)` across the tenant's full active-sub set — N same-plan redeems stack into N durations without colliding on `(tenant_id, period_start)`.
3. INSERTs a new `agent_subscriptions` row keyed on `(tenant_id, period_start)` — append-only so historical `usage_events` stay bound to the pricing window they were billed against
4. Marks the prior active row `status='superseded'` on immediate upgrades
5. Writes the audit row in `coupon_redemptions`

`one_per_user=TRUE` is enforced in Python by `_validate_coupon_row` under the coupon's `FOR UPDATE` lock — no race between the check and the subsequent INSERT. A typed `psycopg.errors.UniqueViolation` catch at the redemption INSERT is kept as defense-in-depth (maps to `CouponAlreadyRedeemed` → HTTP 409) so any future overlapping index surfaces properly instead of hiding behind the route's generic 500. Meter migration 024 dropped the prior partial unique index on `(coupon_id, user_id)` because its predicate fired for every coupon, not just `one_per_user=TRUE` ones — breaking the common `max_redemptions > 1` case.

## Endpoints

All prefixed with `/api/`.

| Method | Path | Auth |
|---|---|---|
| `GET` | `/auth/me` | JWT — returns `{user, tenants, default_tenant_id}` |
| `POST` | `/onboarding/submit` | JWT — gated on `plan_active` |
| `POST` | `/coupons/preview` / `/coupons/redeem` | JWT |
| `GET` `POST` | `/tenants` | JWT |
| `GET` `PATCH` `DELETE` | `/tenants/{id}` | member / admin+ / owner |
| `*` | `/tenants/{id}/members` / `/invites` / `/agents` | admin+ (with per-op role rules) |
| `POST` | `/tenants/{id}/agents/stream` | admin+ — NDJSON provision stream |
| `GET` | `/dashboard/tenants/{id}` | member+ |
| `GET` | `/dashboard/tenants/{id}/usage` | member+ |
| `POST` | `/invites/accept` | JWT |
| `GET` | `/invites/preview?token=...` | none |
| `GET` | `/c/{code}` | none — 302 through `oauth_connect_shortlinks` |
| `*` | `/admin/*` | superadmin |

### Dashboard subscription fallback

`/dashboard/tenants/{id}` pulls the subscription plate from the meter's `GET /admin/spend/tenant/{id}`. When the meter is unreachable (local `uv run dev` without the meter process, a brief prod blip), the response falls back to `db.get_active_subscription(tenant_id)` so the plate keeps rendering — users see a stale-but-present plan rather than a phantom "no active subscription" CTA sitting next to a perfectly live product. `totals` (usage aggregation from `usage_events`) stays `null` in the fallback path because only the meter computes it; the UI renders a zero-state for the spend numbers until the meter is back.

## Provisioning

[services/provisioning.py](services/provisioning.py) exposes an `AgentProvisioner` protocol with two implementations:

- `VmHttpProvisioner` — calls the provision-api systemd daemon on the target OpenClaw VM (10.10.0.2:9200 prod, 10.10.0.3:9200 dev) via Direct VPC egress. Bearer token in Secret Manager (`provision-api-token` / `-dev`). Daemon shells to `create-agent.sh` and streams NDJSON progress (`__PROGRESS__ <n>/<total> <label>`) which the app forwards to the browser.
- `MockProvisioner` — local dev only; writes a realistic `ws://` gateway_url + phone_route to the DB without starting a container. Selected via `AGENTLEH_PROVISIONER=mock` (default) or `vm`.

The provisioner writes the **full** `agents` row atomically — `agent_id`, `gateway_url`, `gateway_token`, `tenant_id`, `agent_name`, `bot_gender`, `tts_voice_name` — so downstream readers never see a partially-populated row. No post-provision UPDATE chain.

## Invite emails (Resend)

[services/email.py](services/email.py) wraps Resend's HTTP API (no SDK). Emails are sent from `Agentiko <noreply@agentiko.io>` with a Hebrew-first RTL template. API key in Secret Manager: `resend-api-key` (prod) / `resend-api-key-dev` (dev).

If Resend returns non-2xx the invite row is still created and the raw token is returned to the inviter as a copy-link fallback — a Resend outage never blocks the flow. Free tier is 3000/month, 100/day; expected v1 volume is <100/month.

## Bilingual UI

[frontend/src/lib/i18n.tsx](frontend/src/lib/i18n.tsx) is a zero-dep ~150-line i18n provider. Call sites use inline bilingual objects:

```tsx
const { t, dir, lang, setLang } = useI18n()
<h2>{t({ he: 'חברים', en: 'Members' })}</h2>
```

Language persists in `localStorage['agentleh.lang']` only when the user clicks the switcher; first-time visitors are detected from `navigator.languages` (normalizes `iw`→`he`, falls back to Hebrew). On every change the provider updates `document.documentElement.lang` + `document.documentElement.dir`. An inline pre-React script in `index.html` runs the same detection before React mounts, so there's no flash of the wrong direction on first paint.

Mixed-script content (Hebrew workspace name inside an English sentence) uses `<bdi>` isolation via the `<TenantName>` component. Tenants with system-default names carry `name_base` so the frontend can render per-language templates (`מרחב העבודה של X` / `X's workspace`) without mangling user-renamed tenants.

## Environments

| | Dev | Prod |
|---|---|---|
| Public URL | `app-dev.agentiko.io` | `app.agentiko.io` |
| Cloud Run service | `agentleh-app-dev` | `agentleh-app` |
| Supabase project | `mnetqtjwcdunznvvfaob` | `hizznfloknpqtznywwsj` |
| Branch | `develop` | `main` |
| Provisioner target | `10.10.0.3:9200` (openclaw-dev) | `10.10.0.2:9200` (openclaw-prod) |
| Meter URL | `https://agentleh-meter-dev-...run.app` | `https://agentleh-meter-...run.app` |

Both routed via the shared Global HTTPS LB (`34.111.24.95`) → backend service → serverless NEG → Cloud Run.

## Running locally

**Preferred — from the parent monorepo** ([agentleh](https://github.com/shaharsha/agentleh)):

```bash
uv run dev-with-meter     # landing + app + meter + local Postgres, auto-wired
uv run app                # app only (implies db-up)
uv run dev-gcp            # same stack wired to agentleh_dev Cloud SQL via proxy
                          # (use for debugging with real shared dev state — writes
                          # are visible to all devs and CI; see parent CLAUDE.md)
```

The parent orchestrator injects `DATABASE_URL` (local Postgres on :15432), `APP_METER_BASE_URL=http://127.0.0.1:8080`, and `APP_METER_ADMIN_TOKEN` for you. Shell-exported values win over orchestrator defaults if you need to point at Cloud SQL proxy or the deployed dev meter.

**Standalone:**

```bash
uv sync                        # Python deps
cd frontend && npm install     # Frontend deps
cd ..
uv run dev                     # Backend (8000) + frontend (5173)
```

Required env vars when running standalone:

- `frontend/.env`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_LANDING_URL`
- Backend: `DATABASE_URL`, `APP_METER_BASE_URL`, `APP_METER_ADMIN_TOKEN`, `APP_VM_STATS_URL` (+ `APP_VM_STATS_TOKEN` if set), `RESEND_API_KEY`, `AGENTLEH_PROVISIONER=mock` (default) or `vm`

Supabase JWT verification is keyless (reads the project's JWKS on startup); no `APP_SUPABASE_JWT_SECRET` needed. Point `VITE_SUPABASE_URL` at a real project and the backend will fetch the matching JWKS on first request.

## CI/CD

GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)):

1. **Test** — `uv run pytest tests/` + `frontend/ && npx tsc -b && npx vite build`
2. **Auth** — Workload Identity Federation
3. **Build** — `gcloud builds submit --config=cloudbuild.yaml` with environment-specific VITE build args
4. **Deploy** — `gcloud run deploy` to prod (on `main`) or dev (on `develop`)
5. **Verify** — curl `/health` on the custom hostname

Required GitHub secrets: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`.

## Secrets at runtime

Cloud Run injects from Google Secret Manager (prod name / dev name):

- `DATABASE_URL` / `database-url-dev` — Cloud SQL private IP
- `APP_METER_ADMIN_TOKEN` / `meter-admin-token-dev` — proxy token for `/admin/*` routes that call the meter
- `AGENTLEH_PROVISION_API_TOKEN` / `provision-api-token-dev` — bearer for the VM provision-api daemon
- `RESEND_API_KEY` / `resend-api-key-dev` — transactional email
- `APP_VM_STATS_TOKEN` / `vm-stats-token-dev` — the Stats tab's VM metrics fetch

Plain env: `ENV_FOR_DYNACONF=production` (or `development`), `AGENTLEH_PROVISIONER=vm`, `APP_METER_BASE_URL`, `APP_VM_STATS_URL`, `AGENTLEH_PROVISION_API_URL`.

## Design System

Shared with the landing page. Brand spec lives at the parent repo root: [BRAND.md](../BRAND.md). Primary palette: cream `#F3EAD3`, navy `#0E1320`, terracotta `#B85A3A`.

Use semantic tokens — never raw Tailwind color classes:

- **Brand**: `bg-brand` / `text-brand` / `ring-brand` (+ `-light` / `-dark` / `-50` / `-100`)
- **Surface**: `bg-surface` / `bg-surface-soft` — NEVER `bg-white` (white is reserved for input fields)
- **Text**: `text-text-primary` / `text-text-secondary` / `text-text-muted` — NEVER `text-gray-*`
- **Border**: `border-border` / `border-border-light` — NEVER `border-gray-*`
- **Semantic**: `text-danger` / `bg-danger-light`, `text-warning`, `text-success`, `text-info` — NEVER raw `text-red-*` / `bg-amber-*`

Shared classes: `glass-nav`, `glass-card`, `glass-card-elevated`, `glass-card-hover`, `glass-pill`, `section-gradient`, `section-gradient-alt`, `section-gradient-hero`, `btn-brand`, `btn-secondary`, `btn-sm`, `btn-md`, `input-glass`.

Canonical logo assets at [frontend/public/brand/](frontend/public/brand/) (icon + wordmark, light + dark, SVG + PNG). Theme-aware swap pattern: `<img class="block dark:hidden" src="/brand/logo-icon.svg">` paired with `<img class="hidden dark:block" src="/brand/logo-icon-dark.svg">`. The LogOut icon flips horizontally in RTL so the arrow head faces the reading edge.

All URLs configurable via `VITE_*` env vars. No hardcoded domains in code.
