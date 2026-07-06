import os
from fastapi import FastAPI, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import select, func

from .db import get_engine, make_session_factory, Base
from .models import TrainingAttempt

DB_URL = os.getenv("DB_URL", "sqlite:////data/app.db")

engine = get_engine(DB_URL)
SessionLocal = make_session_factory(engine)
Base.metadata.create_all(bind=engine)

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

class AttemptIn(BaseModel):
  midi_note: int = Field(..., ge=0, le=127)
  score: float = Field(..., ge=0, le=100)
  cents_abs_mean: float | None = None
  cents_p95_abs: float | None = None
  confidence_mean: float | None = None
  duration_ms: int | None = None

def _save_attempt(payload: AttemptIn, db: Session):
  a = TrainingAttempt(**payload.model_dump())
  db.add(a)
  db.commit()
  db.refresh(a)
  return {"id": a.id, "created_at": a.created_at.isoformat()}

@app.post("/training/attempts")
@app.post("/api/training/attempts")
def save_attempt(payload: AttemptIn, db: Session = Depends(get_db)):
  return _save_attempt(payload, db)

def _list_attempts(limit: int, db: Session):
  rows = db.execute(
    select(TrainingAttempt).order_by(TrainingAttempt.id.desc()).limit(limit)
  ).scalars().all()
  return [
    {
      "id": r.id,
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
def list_attempts(limit: int = 50, db: Session = Depends(get_db)):
  return _list_attempts(limit, db)

def _stats_by_note(db: Session):
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
def stats_by_note(db: Session = Depends(get_db)):
  return _stats_by_note(db)
