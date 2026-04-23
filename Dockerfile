FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

# Install Node.js for frontend build
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv
ENV UV_PROJECT_ENVIRONMENT=/usr/local

WORKDIR /app

# Python deps — install from lockfile so pyproject.toml is source of truth
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Frontend deps
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci --production=false 2>/dev/null || cd frontend && npm install

# Build frontend (VITE_ vars must be available at build time)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_LANDING_URL
ARG VITE_LOGROCKET_APP_ID
COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Copy backend
COPY . .

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser /app
USER appuser

EXPOSE 8080
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log", "--workers", "2"]
