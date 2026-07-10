import os
import json
import secrets
from typing import Any

from datetime import datetime
from passlib.context import CryptContext
from sqlalchemy.exc import IntegrityError

from fastapi import FastAPI, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import select, func, text

from .db import get_engine, make_session_factory, Base
from .models import TrainingAttempt, User, ExerciseAttempt

from passlib.exc import UnknownHashError

DB_URL = os.getenv("DB_URL", "sqlite:////data/app.db")

engine = get_engine(DB_URL)
SessionLocal = make_session_factory(engine)

# Create new tables (won't alter old ones)
Base.metadata.create_all(bind=engine)

pwd_ctx = CryptContext(
    schemes=["bcrypt_sha256", "bcrypt"],  # сначала новая, потом старая
    deprecated=["bcrypt"],                # старую считаем устаревшей
)

def _norm_username(s: str) -> str:
  return s.strip().lower()


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

        # users: add auth / billing columns if missing
        ucols = conn.exec_driver_sql("PRAGMA table_info(users)").all()
        ucolnames = {c[1] for c in ucols}

        def add_col_if_missing(name: str, ddl: str):
            if name not in ucolnames:
                conn.exec_driver_sql(ddl)

        add_col_if_missing("username", "ALTER TABLE users ADD COLUMN username TEXT")
        add_col_if_missing("username_norm", "ALTER TABLE users ADD COLUMN username_norm TEXT")
        add_col_if_missing("password_hash", "ALTER TABLE users ADD COLUMN password_hash TEXT")
        add_col_if_missing("registered_at", "ALTER TABLE users ADD COLUMN registered_at DATETIME")

        add_col_if_missing("plan", "ALTER TABLE users ADD COLUMN plan TEXT")
        add_col_if_missing("paid_until", "ALTER TABLE users ADD COLUMN paid_until DATETIME")

        add_col_if_missing("ai_enabled", "ALTER TABLE users ADD COLUMN ai_enabled INTEGER")
        add_col_if_missing("ai_credits_total", "ALTER TABLE users ADD COLUMN ai_credits_total INTEGER")
        add_col_if_missing("ai_credits_used", "ALTER TABLE users ADD COLUMN ai_credits_used INTEGER")

        add_col_if_missing("entitlements_json", "ALTER TABLE users ADD COLUMN entitlements_json TEXT")

        # exercise_attempts.root_midi column
        ecols = conn.exec_driver_sql("PRAGMA table_info(exercise_attempts)").all()
        ecolnames = {c[1] for c in ecols}
        if "root_midi" not in ecolnames:
            conn.exec_driver_sql("ALTER TABLE exercise_attempts ADD COLUMN root_midi INTEGER")

            # optional backfill for existing rows (best effort):
            rows = conn.exec_driver_sql(
                "SELECT id, steps_json FROM exercise_attempts WHERE root_midi IS NULL"
            ).all()

            for (aid, steps_json) in rows:
                try:
                    steps = json.loads(steps_json) if steps_json else []
                    root = steps[0].get("target_midi") if steps else None
                    if isinstance(root, int):
                        conn.exec_driver_sql(
                            "UPDATE exercise_attempts SET root_midi = ? WHERE id = ?",
                            (root, aid),
                        )
                except Exception:
                    pass

        # indexes (safe)
        # conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_exercise_attempts_root_midi ON exercise_attempts(root_midi)")
        
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS idx_exercise_attempts_user_root_midi ON exercise_attempts(user_id, root_midi)"
        )

        # defaults for old rows (safe even if table already had values)
        conn.exec_driver_sql("UPDATE users SET plan='free' WHERE plan IS NULL")
        conn.exec_driver_sql("UPDATE users SET ai_enabled=0 WHERE ai_enabled IS NULL")
        conn.exec_driver_sql("UPDATE users SET ai_credits_total=0 WHERE ai_credits_total IS NULL")
        conn.exec_driver_sql("UPDATE users SET ai_credits_used=0 WHERE ai_credits_used IS NULL")
        conn.exec_driver_sql("UPDATE users SET entitlements_json='{}' WHERE entitlements_json IS NULL")

        # indexes / uniqueness
        # conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_users_username_norm ON users(username_norm)")
        # уникальность — через UNIQUE INDEX (SQLite-friendly)
        conn.exec_driver_sql("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username_norm ON users(username_norm)")
        conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan)")

        # conn.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)")
        
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
    u = User(
        token=token,
        plan="free",
        ai_enabled=0,
        ai_credits_total=0,
        ai_credits_used=0,
        entitlements_json="{}",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return AuthOut(user_id=u.id, token=u.token, created_at=u.created_at.isoformat())


class CredentialsIn(BaseModel):
  username: str = Field(..., min_length=3, max_length=32)
  password: str = Field(..., min_length=4, max_length=128)

@app.post("/auth/register")
@app.post("/api/auth/register")
def auth_register(
  payload: CredentialsIn,
  db: Session = Depends(get_db),
  u: User | None = Depends(get_current_user),
) -> AuthOut:
  u = require_user(u)

  if u.username_norm:
    raise HTTPException(status_code=409, detail="Already registered")

  username = payload.username.strip()
  if any(ch.isspace() for ch in username):
    raise HTTPException(status_code=400, detail="Username must not contain spaces")

  uname_norm = _norm_username(username)

  # быстрый pre-check
  taken = db.execute(select(User).where(User.username_norm == uname_norm)).scalar_one_or_none()
  if taken:
    raise HTTPException(status_code=409, detail="Username taken")

  u.username = username
  u.username_norm = uname_norm
  u.password_hash = pwd_ctx.hash(payload.password)
  u.registered_at = datetime.utcnow()

  # defaults, если вдруг NULL
  if not u.plan:
    u.plan = "free"
  if u.ai_enabled is None:
    u.ai_enabled = 0
  if u.ai_credits_total is None:
    u.ai_credits_total = 0
  if u.ai_credits_used is None:
    u.ai_credits_used = 0
  if not u.entitlements_json:
    u.entitlements_json = "{}"

  try:
    db.commit()
  except IntegrityError:
    db.rollback()
    # на случай гонки
    raise HTTPException(status_code=409, detail="Username taken")

  db.refresh(u)
  return AuthOut(user_id=u.id, token=u.token, created_at=u.created_at.isoformat())


@app.post("/auth/login")
@app.post("/api/auth/login")
def auth_login(payload: CredentialsIn, db: Session = Depends(get_db)) -> AuthOut:
    uname_norm = _norm_username(payload.username)

    u = db.execute(select(User).where(User.username_norm == uname_norm)).scalar_one_or_none()
    if not u or not u.password_hash:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    try:
        ok = pwd_ctx.verify(payload.password, u.password_hash)
    except UnknownHashError:
        # Хэш в БД не распознан (старый/битый/неизвестный формат) → не 500, а 401
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not ok:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Опционально: авто-апгрейд хэша до актуальной схемы
    if pwd_ctx.needs_update(u.password_hash):
        u.password_hash = pwd_ctx.hash(payload.password)
        db.commit()

    return AuthOut(user_id=u.id, token=u.token, created_at=u.created_at.isoformat())



@app.get("/me")
@app.get("/api/me")
def me(u: User | None = Depends(get_current_user)):
  u = require_user(u)

  plan = u.plan or "free"
  ai_enabled = bool(u.ai_enabled) if u.ai_enabled is not None else False

  return {
    "user_id": u.id,
    "created_at": u.created_at.isoformat(),
    "username": u.username,
    "is_registered": bool(u.username_norm),
    "plan": plan,
    "paid_until": u.paid_until.isoformat() if u.paid_until else None,
    "ai_enabled": ai_enabled,
    "ai_credits_total": int(u.ai_credits_total or 0),
    "ai_credits_used": int(u.ai_credits_used or 0),
  }


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

    root_midi: int | None = Field(default=None, ge=0, le=127)
    
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
        root_midi=payload.root_midi,
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
  offset: int = 0,
  root_midi: int | None = None,
  db: Session = Depends(get_db),
  u: User | None = Depends(get_current_user),
):
  u = require_user(u)

  q = select(ExerciseAttempt).where(ExerciseAttempt.user_id == u.id)

  if root_midi is not None:
    q = q.where(ExerciseAttempt.root_midi == root_midi)

  rows = (
    db.execute(
      q.order_by(ExerciseAttempt.id.desc()).offset(offset).limit(limit)
    )
    .scalars()
    .all()
  )

  out = []
  for r in rows:
    out.append({
      "id": r.id,
      "exercise_id": r.exercise_id,
      "mode": r.mode,
      "timing_mode": r.timing_mode,
      "root_midi": r.root_midi,
      "total_time_ms": r.total_time_ms,
      "score_total": r.score_total,
      "avg_time_to_green_ms": r.avg_time_to_green_ms,
      "p95_time_to_green_ms": r.p95_time_to_green_ms,
      "avg_abs_cents": r.avg_abs_cents,
      "p95_abs_cents": r.p95_abs_cents,
      "steps": json.loads(r.steps_json),
      "created_at": r.created_at.isoformat(),
    })

  return out