from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

def get_engine(db_url: str):
    connect_args = {}
    if db_url.startswith("sqlite:"):
        connect_args = {"check_same_thread": False}
    return create_engine(db_url, connect_args=connect_args, future=True)

class Base(DeclarativeBase):
    pass

def make_session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
