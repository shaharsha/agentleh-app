"""Dev scripts — run backend, frontend, or both."""

import subprocess
import sys


def backend():
    subprocess.run(
        [sys.executable, "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"],
        check=True,
    )


def dev():
    """Run backend + frontend concurrently."""
    import signal

    procs = []
    try:
        procs.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"],
        ))
        procs.append(subprocess.Popen(
            ["npm", "run", "dev"],
            cwd="frontend",
        ))
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        for p in procs:
            p.send_signal(signal.SIGTERM)
        for p in procs:
            p.wait()


def test():
    subprocess.run([sys.executable, "-m", "pytest", "tests/", "-v"], check=True)
