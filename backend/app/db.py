from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings


def normalize_database_url(url: str) -> str:
    raw = (url or "").strip()
    # Railway Postgres 常给 postgresql://（甚至可能被手动写成 Postgresql://）
    # 当前项目主驱动是 psycopg（非 psycopg2），统一归一化为 postgresql+psycopg://。
    raw_lower = raw.lower()
    if raw_lower.startswith("postgresql://") or raw_lower.startswith("postgres://"):
        suffix = raw.split("://", 1)[1] if "://" in raw else raw
        return f"postgresql+psycopg://{suffix}"
    return raw


database_url = normalize_database_url(settings.database_url)
connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
engine = create_engine(database_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
