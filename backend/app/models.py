from sqlalchemy import Integer, Float, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime
from .db import Base

class TrainingAttempt(Base):
    __tablename__ = "training_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # пока без пользователей; позже добавим user_id
    midi_note: Mapped[int] = mapped_column(Integer, nullable=False)

    score: Mapped[float] = mapped_column(Float, nullable=False)
    cents_abs_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    cents_p95_abs: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence_mean: Mapped[float | None] = mapped_column(Float, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
