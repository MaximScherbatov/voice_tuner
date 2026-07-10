from datetime import datetime

from sqlalchemy import Integer, Float, DateTime, String, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    # --- Registration (optional; guest users have NULLs) ---
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    username_norm: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True, unique=True)

    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    registered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # --- Paid / AI entitlements (future-proof fields) ---
    plan: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)  # "free" / "pro" / "trial"
    paid_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    ai_enabled: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 0/1
    ai_credits_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ai_credits_used: Mapped[int | None] = mapped_column(Integer, nullable=True)

    entitlements_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # "{}" etc

    training_attempts = relationship("TrainingAttempt", back_populates="user")
    exercise_attempts = relationship("ExerciseAttempt", back_populates="user")


class TrainingAttempt(Base):
    __tablename__ = "training_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # NEW: user
    user_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    user = relationship("User", back_populates="training_attempts")

    midi_note: Mapped[int] = mapped_column(Integer, nullable=False)
    score: Mapped[float] = mapped_column(Float, nullable=False)

    cents_abs_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    cents_p95_abs: Mapped[float | None] = mapped_column(Float, nullable=True)

    confidence_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class ExerciseAttempt(Base):
    """
    One exercise run (arpeggio/scale/sequence), including per-step metrics (JSON).
    """
    __tablename__ = "exercise_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    user = relationship("User", back_populates="exercise_attempts")

    exercise_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    mode: Mapped[str] = mapped_column(String(16), nullable=False)         # assist / challenge
    timing_mode: Mapped[str] = mapped_column(String(16), nullable=False)  # flow / tempo

    root_midi: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    total_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    score_total: Mapped[float | None] = mapped_column(Float, nullable=True)

    avg_time_to_green_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    p95_time_to_green_ms: Mapped[float | None] = mapped_column(Float, nullable=True)

    avg_abs_cents: Mapped[float | None] = mapped_column(Float, nullable=True)
    p95_abs_cents: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Per-step metrics; we keep it simple for MVP.
    steps_json: Mapped[str] = mapped_column(Text, nullable=False)

    # Optional: for future "history graphs". Keep nullable now.
    trace_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)