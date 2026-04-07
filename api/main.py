"""FastAPI app for the Agentleh web application."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from api.routes.auth import router as auth_router
from api.routes.dashboard import router as dashboard_router
from api.routes.onboarding import router as onboarding_router
from api.routes.payment import router as payment_router
from lib.config import get_database_url, settings
from lib.db import AppDatabase

logger = logging.getLogger(__name__)

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_url = os.environ.get("DATABASE_URL") or get_database_url()
    if not db_url:
        logger.error("DATABASE_URL not set")
        raise RuntimeError("DATABASE_URL is required")

    db = AppDatabase(db_url)
    db.init()
    app.state.db = db

    # Initialize services (mock or real based on config)
    use_mocks = getattr(settings, "use_mocks", True)
    if use_mocks:
        from services.payment import MockPayment
        from services.provisioning import MockProvisioner
        from services.whatsapp import MockWhatsApp

        app.state.provisioner = MockProvisioner(
            db=db,
            gateway_base_url=str(getattr(settings, "gateway_base_url", "")),
        )
        app.state.payment = MockPayment()
        app.state.whatsapp = MockWhatsApp()
        logger.info("Using MOCK services")
    else:
        raise NotImplementedError("Real services not implemented yet")

    yield


app = FastAPI(title="Agentleh App", lifespan=lifespan)

# CORS
_cors_origins = str(getattr(settings, "cors_allowed_origins", "http://localhost:5173")).strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# API routes
app.include_router(auth_router, prefix="/api")
app.include_router(payment_router, prefix="/api")
app.include_router(onboarding_router, prefix="/api")
app.include_router(dashboard_router, prefix="/api")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    """Serve static files from the frontend build, with SPA fallback to index.html."""
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")

    if STATIC_DIR.exists():
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            try:
                candidate.resolve().relative_to(STATIC_DIR.resolve())
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid path")
            return FileResponse(candidate)

        idx = STATIC_DIR / "index.html"
        if idx.exists():
            return FileResponse(idx)

    raise HTTPException(status_code=404, detail="No frontend build found")
