import os
import json
import secrets
from typing import Any

from fastapi import FastAPI, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import select, func, text

from .db import get_engine, make_session_factory, Base
from .models import TrainingAttempt, User, ExerciseAttempt

DB_URL = os.getenv("DB_URL", "sqlite:////data/app.db")

engine = get_engine(DB_URL)
SessionLocal = make_session_factory(engine)

# Create new tables (won't alter old ones)
Base.metadata.create_all(bind=engine)


def ensure_schema_sqlite():
    """
    Lightweight migration for SQLite:
    - add training_attempts.user_id if missing
    - add indexes if missing
    """
    if engine.dialect.name != "sqlite":
        return

    with engine.begin() as conn:
        # training_attempts.user_id column
        cols = conn.exec_driver_sql("PRAGMA table_info(training_attempts)").all()
        colnames = {c[1] for c in cols}  # (cid, name, type, notnull, dflt_value, pk)

        if "user_id" not in colnames:
            conn.exec_driver_sql("ALTER TABLE training_attempts ADD COLUMN user_id INTEGER")

        # indexes (safe)
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_training_attempts_user_id ON training_attempts(user_id)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_exercise_attempts_user_id ON exercise_attempts(user_id)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_exercise_attempts_exercise_id ON exercise_attempts(exercise_id)"
        )


ensure_schema_sqlite()

app = FastAPI(title="Voice Trainer Pro API")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _health():
    return {"status": "ok"}


@app.get("/health")
@app.get("/api/health")
def health():
    return _health()


def _parse_bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2:
        return None
    typ, token = parts[0].strip().lower(), parts[1].strip()
    if typ != "bearer" or not token:
        return None
    return token


def get_current_user(
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> User | None:
    token = _parse_bearer_token(authorization)
    if not token:
        return None
    u = db.execute(select(User).where(User.token == token)).scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=401, detail="Invalid token")
    return u


def require_user(u: User | None) -> User:
    if not u:
        raise HTTPException(status_code=401, detail="Auth required")
    return u


# -----------------------
# Auth
# -----------------------

class AuthOut(BaseModel):
    user_id: int
    token: str
    created_at: str


@app.post("/auth/anonymous")
@app.post("/api/auth/anonymous")
def auth_anonymous(db: Session = Depends(get_db)) -> AuthOut:
    token = secrets.token_urlsafe(32)
    u = User(token=token)
    db.add(u)
    db.commit()
    db.refresh(u)
    return AuthOut(user_id=u.id, token=u.token, created_at=u.created_at.isoformat())


@app.get("/me")
@app.get("/api/me")
def me(u: User | None = Depends(get_current_user)):
    u = require_user(u)
    return {"user_id": u.id, "created_at": u.created_at.isoformat()}


# -----------------------
# Single-note attempts (legacy + now user-aware)
# -----------------------

class AttemptIn(BaseModel):
    midi_note: int = Field(..., ge=0, le=127)
    score: float = Field(..., ge=0, le=100)
    cents_abs_mean: float | None = None
    cents_p95_abs: float | None = None
    confidence_mean: float | None = None
    duration_ms: int | None = None


def _save_attempt(payload: AttemptIn, db: Session, u: User | None):
    data = payload.model_dump()
    if u:
        data["user_id"] = u.id
    a = TrainingAttempt(**data)
    db.add(a)
    db.commit()
    db.refresh(a)
    return {"id": a.id, "created_at": a.created_at.isoformat(), "user_id": a.user_id}


@app.post("/training/attempts")
@app.post("/api/training/attempts")
def save_attempt(
    payload: AttemptIn,
    db: Session = Depends(get_db),
    u: User | None = Depends(get_current_user),
):
    return _save_attempt(payload, db, u)


def _list_attempts(limit: int, db: Session, u: User | None):
    q = select(TrainingAttempt).order_by(TrainingAttempt.id.desc()).limit(limit)
    if u:
        q = q.where(TrainingAttempt.user_id == u.id)

    rows = db.execute(q).scalars().all()
    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "midi_note": r.midi_note,
            "score": r.score,
            "cents_abs_mean": r.cents_abs_mean,
            "cents_p95_abs": r.cents_p95_abs,
            "confidence_mean": r.confidence_mean,
            "duration_ms": r.duration_ms,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@app.get("/training/attempts")
@app.get("/api/training/attempts")
def list_attempts(
    limit: int = 50,
    db: Session = Depends(get_db),
    u: User | None = Depends(get_current_user),
):
    return _list_attempts(limit, db, u)


def _stats_by_note(db: Session, u: User | None):
    q = (
        select(
            TrainingAttempt.midi_note,
            func.count().label("attempts"),
            func.avg(TrainingAttempt.score).label("score_avg"),
            func.max(TrainingAttempt.score).label("score_max"),
        )
        .group_by(TrainingAttempt.midi_note)
        .order_by(TrainingAttempt.midi_note)
    )

    if u:
        q = q.where(TrainingAttempt.user_id == u.id)

    rows = db.execute(q).all()
    return [
        {
            "midi_note": midi,
            "attempts": int(attempts),
            "score_avg": float(score_avg) if score_avg is not None else None,
            "score_max": float(score_max) if score_max is not None else None,
        }
        for (midi, attempts, score_avg, score_max) in rows
    ]


@app.get("/stats/notes")
@app.get("/api/stats/notes")
def stats_by_note(
    db: Session = Depends(get_db),
    u: User | None = Depends(get_current_user),
):
    return _stats_by_note(db, u)


# -----------------------
# Exercise attempts (new)
# -----------------------

class StepMetric(BaseModel):
    step_index: int = Field(..., ge=0)
    target_midi: int = Field(..., ge=0, le=127)

    time_to_green_ms: int | None = Field(default=None, ge=0)
    time_in_green_ms: int | None = Field(default=None, ge=0)
    pct_in_green: float | None = Field(default=None, ge=0, le=100)

    median_abs_cents: float | None = None
    p95_abs_cents: float | None = None

    overshoot_max_cents: float | None = None
    drift_cents_per_s: float | None = None
    correction_count: int | None = Field(default=None, ge=0)

    clarity_mean: float | None = None
    rms_mean: float | None = None


class ExerciseAttemptIn(BaseModel):
    exercise_id: str = Field(..., min_length=1, max_length=64)

    mode: str = Field(..., min_length=1, max_length=16)        # assist/challenge
    timing_mode: str = Field(..., min_length=1, max_length=16) # flow/tempo

    total_time_ms: int | None = Field(default=None, ge=0)
    score_total: float | None = Field(default=None, ge=0, le=100)

    avg_time_to_green_ms: float | None = None
    p95_time_to_green_ms: float | None = None

    avg_abs_cents: float | None = None
    p95_abs_cents: float | None = None

    steps: list[StepMetric] = Field(default_factory=list)

    # optional, keep nullable
    trace: list[Any] | None = None


@app.post("/exercise_attempts")
@app.post("/api/exercise_attempts")
def save_exercise_attempt(
    payload: ExerciseAttemptIn,
    db: Session = Depends(get_db),
    u: User | None = Depends(get_current_user),
):
    u = require_user(u)

    steps_json = json.dumps([s.model_dump() for s in payload.steps], ensure_ascii=False)
    trace_json = json.dumps(payload.trace, ensure_ascii=False) if payload.trace is not None else None

    a = ExerciseAttempt(
        user_id=u.id,
        exercise_id=payload.exercise_id,
        mode=payload.mode,
        timing_mode=payload.timing_mode,
        total_time_ms=payload.total_time_ms,
        score_total=payload.score_total,
        avg_time_to_green_ms=payload.avg_time_to_green_ms,
        p95_time_to_green_ms=payload.p95_time_to_green_ms,
        avg_abs_cents=payload.avg_abs_cents,
        p95_abs_cents=payload.p95_abs_cents,
        steps_json=steps_json,
        trace_json=trace_json,
    )
    db.add(a)
    db.commit()
    db.refresh(a)

    return {"id": a.id, "created_at": a.created_at.isoformat()}


@app.get("/exercise_attempts")
@app.get("/api/exercise_attempts")
def list_exercise_attempts(
    limit: int = 50,
    db: Session = Depends(get_db),
    u: User | None = Depends(get_current_user),
):
    u = require_user(u)

    rows = (
        db.execute(
            select(ExerciseAttempt)
            .where(ExerciseAttempt.user_id == u.id)
            .order_by(ExerciseAttempt.id.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )

    out = []
    for r in rows:
        out.append(
            {
                "id": r.id,
                "exercise_id": r.exercise_id,
                "mode": r.mode,
                "timing_mode": r.timing_mode,
                "total_time_ms": r.total_time_ms,
                "score_total": r.score_total,
                "avg_time_to_green_ms": r.avg_time_to_green_ms,
                "p95_time_to_green_ms": r.p95_time_to_green_ms,
                "avg_abs_cents": r.avg_abs_cents,
                "p95_abs_cents": r.p95_abs_cents,
                "steps": json.loads(r.steps_json),
                "created_at": r.created_at.isoformat(),
            }
        )
    return out