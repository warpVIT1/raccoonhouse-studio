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
    _repair_stale_episode_paths()


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


_EPISODE_PATH_COLUMNS = ("audio_stem_path", "vocal_stem_path", "vocal_only_stem_path")


def _repair_stale_episode_paths():
    """If the app's own data directory moved (see electron/main.ts's
    userData-to-install-drive migration), every episode row that still
    points at the OLD directory needs re-anchoring — moving files on disk
    doesn't touch absolute paths already stored in the database, and a raw
    byte-level rewrite of the .db file isn't safe (SQLite's record layout
    encodes string lengths; a differently-sized replacement path would
    corrupt it). Only touches the 3 columns this codebase itself always
    generates as <DATA_DIR>/episodes/<id>/... — never
    original_file_path (the user's own source video, never copied here) or
    a batch result the user redirected to a folder of their own choosing
    (that file never moved, so its stored path is still correct)."""
    with engine.begin() as conn:
        rows = conn.execute(text(
            f'SELECT id, {", ".join(_EPISODE_PATH_COLUMNS)} FROM episodes'
        )).fetchall()
        for row in rows:
            ep_id = row[0]
            updates = {}
            for col, stored in zip(_EPISODE_PATH_COLUMNS, row[1:]):
                fixed = _reanchor_episode_path(stored, ep_id)
                if fixed:
                    updates[col] = fixed
            if updates:
                set_clause = ", ".join(f'"{c}" = :{c}' for c in updates)
                conn.execute(text(f'UPDATE episodes SET {set_clause} WHERE id = :id'), {**updates, "id": ep_id})


def _reanchor_episode_path(stored_path, episode_id) -> "str | None":
    if not stored_path or os.path.isfile(stored_path):
        return None  # nothing stored, or already valid — nothing to fix
    marker = os.path.join("episodes", str(episode_id))
    idx = stored_path.rfind(marker)
    if idx == -1:
        return None  # not a path this codebase generated under episodes/<id>/ — leave it alone
    remainder = stored_path[idx + len(marker):].lstrip("\\/")
    candidate = os.path.join(DATA_DIR, "episodes", str(episode_id), remainder)
    return candidate if os.path.isfile(candidate) else None


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
