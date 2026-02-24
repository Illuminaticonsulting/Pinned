"""Health check endpoint."""

from __future__ import annotations

import time

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    """Return service health status including dependency connectivity.

    Returns:
        JSON with status, Redis/DB connectivity, model state, and uptime.
    """
    from app.main import app_state

    redis_ok = False
    if app_state.redis is not None:
        try:
            await app_state.redis.ping()
            redis_ok = True
        except Exception:
            pass

    db_ok = False
    if app_state.db_pool is not None:
        conn = None
        try:
            conn = app_state.db_pool.getconn()
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            db_ok = True
        except Exception:
            pass
        finally:
            if conn is not None:
                try:
                    app_state.db_pool.putconn(conn)
                except Exception:
                    pass

    uptime = time.time() - app_state.start_time if app_state.start_time else 0.0

    return {
        "status": "ok",
        "redis": "connected" if redis_ok else "disconnected",
        "db": "connected" if db_ok else "disconnected",
        "models_loaded": app_state.models_loaded,
        "uptime_seconds": round(uptime, 1),
    }
