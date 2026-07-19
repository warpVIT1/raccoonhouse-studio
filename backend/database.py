import os
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(DATA_DIR, "raccoonhouse.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from . import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _sync_missing_columns()


def _sync_missing_columns():
    """SQLAlchemy's create_all() only creates missing TABLES, not missing
    COLUMNS on tables that already exist — so an app update that adds a column
    to an existing model (e.g. AppSettings.power_share_enabled) would otherwise
    break every install that already has a database. There's no Alembic wiring
    in this project, so patch the gap directly with SQLite's ADD COLUMN."""
    with engine.begin() as conn:
        for table in Base.metadata.tables.values():
            existing = {row[1] for row in conn.execute(text(f'PRAGMA table_info("{table.name}")'))}
            for column in table.columns:
                if column.name in existing:
                    continue
                col_type = column.type.compile(dialect=engine.dialect)
                default_sql = _default_sql_for(column)
                conn.execute(text(
                    f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type} {default_sql}'
                ))


def _default_sql_for(column) -> str:
    if column.nullable:
        return "DEFAULT NULL"
    default = column.default.arg if column.default is not None else None
    if isinstance(default, bool):
        return f"NOT NULL DEFAULT {1 if default else 0}"
    if isinstance(default, (int, float)):
        return f"NOT NULL DEFAULT {default}"
    if isinstance(default, str):
        escaped = default.replace("'", "''")
        return f"NOT NULL DEFAULT '{escaped}'"
    # No usable default and NOT NULL — SQLite requires *some* default to add
    # the column to existing rows, so fall back to nullable rather than fail.
    return "DEFAULT NULL"
