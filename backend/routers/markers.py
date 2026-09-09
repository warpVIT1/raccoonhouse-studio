import io
import os
import csv
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Marker, Episode
from ..schemas import MarkerCreate, MarkerUpdate, MarkerOut, MarkerColorAssign, MarkerImportRequest

router = APIRouter(tags=["markers"])


def _push_if_shared(ep_id: int, db: Session) -> None:
    ep = db.get(Episode, ep_id)
    if ep and ep.title.shared_id:
        from ..services.sync_service import push_markers
        push_markers(ep_id, db)


def _content_disposition(filename: str) -> str:
    """See routers/subtitles.py's identical helper — HTTP header VALUES
    must be latin-1/ASCII, so a raw Cyrillic character_code in the filename
    (e.g. "ГГ") throws UnicodeEncodeError rather than a clean response."""
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "download"
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/episodes/{ep_id}/markers", response_model=List[MarkerOut])
def list_markers(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    return db.query(Marker).filter(Marker.episode_id == ep_id).order_by(Marker.position_seconds).all()


@router.post("/episodes/{ep_id}/markers", response_model=MarkerOut, status_code=201)
def create_marker(ep_id: int, body: MarkerCreate, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    marker = Marker(episode_id=ep_id, **body.model_dump())
    db.add(marker)
    db.commit()
    db.refresh(marker)
    _push_if_shared(ep_id, db)
    return marker


@router.put("/episodes/{ep_id}/markers/by-color", response_model=List[MarkerOut])
def assign_markers_by_color(ep_id: int, body: MarkerColorAssign, db: Session = Depends(get_db)):
    """Bulk-assigns every marker of a given color to one actor at once —
    the sound engineer colors markers per actor while working (in-app or in
    Reaper, then imports), then does this once per color instead of picking
    an actor on every single marker."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    markers = db.query(Marker).filter(Marker.episode_id == ep_id, Marker.color == body.color).all()
    for m in markers:
        m.character_id = body.character_id
    db.commit()
    _push_if_shared(ep_id, db)
    return db.query(Marker).filter(Marker.episode_id == ep_id).order_by(Marker.position_seconds).all()


def _time_to_seconds(value: str, bpm: float = 120.0, beats_per_bar: int = 4) -> float:
    """Two real formats show up in a "Start" column here, distinguished by
    whether it contains a colon at all:
      - 'H:MM:SS.mmm' (colon-separated) — this app's OWN export format
        (see reaper_exporter._seconds_to_time), 3-digit fraction.
      - 'Bar.Beat.Fraction' (dot-only, e.g. "4.3.99691940") — Reaper's own
        native marker CSV export when the project ruler is set to
        Measures.Beats (confirmed live 2026-08-18 against a real Reaper-
        exported file: the colon-only parser silently zeroed out every
        single marker, since none of these have a colon at all). Bar/beat
        are 1-indexed; the fraction is the position within that beat.
        Converting to seconds needs the project's actual tempo, which the
        CSV itself never carries — bpm defaults to Reaper's own new-project
        default (120) and is user-adjustable at import time (see
        MarkerImportRequest.bpm)."""
    value = value.strip()
    if ":" in value:
        parts = value.split(":")
        if len(parts) != 3:
            return 0.0
        h, m, s = int(parts[0]), int(parts[1]), float(parts[2])
        return h * 3600 + m * 60 + s

    parts = value.split(".")
    if len(parts) != 3:
        return 0.0
    try:
        bar = int(parts[0])
        beat = int(parts[1])
        frac = float(f"0.{parts[2]}")
    except ValueError:
        return 0.0
    total_beats = (bar - 1) * beats_per_bar + (beat - 1) + frac
    return total_beats * 60.0 / bpm


@router.post("/episodes/{ep_id}/markers/import", response_model=List[MarkerOut])
def import_markers_csv(ep_id: int, body: MarkerImportRequest, db: Session = Depends(get_db)):
    """Imports the app's own marker CSV shape (see reaper_exporter.
    export_marker_csv: '#,Name,Start,End,Length' plus an optional trailing
    'Color' column) — a round-trippable interchange format, not a claim of
    literal Reaper-native compatibility (Reaper's own marker CSV export has
    no color column). Reads straight off disk like subtitles.py's ASS
    import does (see AssImportRequest) rather than a multipart upload —
    same convention this app already uses for local-file imports.
    Synchronous — small/fast, unlike ASS import's thread-pool job."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    if not os.path.isfile(body.file_path):
        raise HTTPException(400, f"CSV file not found: {body.file_path}")
    with open(body.file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    reader = csv.reader(io.StringIO(raw))
    rows = list(reader)
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]
    try:
        name_idx = header.index("name")
        start_idx = header.index("start")
    except ValueError:
        raise HTTPException(400, "CSV має містити колонки Name та Start")
    color_idx = header.index("color") if "color" in header else None

    created: list[Marker] = []
    for row in rows[1:]:
        if len(row) <= start_idx or not row[start_idx].strip():
            continue
        name = row[name_idx].strip() if len(row) > name_idx else ""
        color = row[color_idx].strip() if color_idx is not None and len(row) > color_idx and row[color_idx].strip() else None
        # Reaper writes a bare hex triplet ("FF0000"), not a CSS color
        # ("#FF0000") — this app's own color picker/swatch rendering
        # (MarkersTab.tsx's `style={{ background: color }}`) needs the '#'.
        if color and not color.startswith("#"):
            color = f"#{color}"
        marker = Marker(
            episode_id=ep_id,
            reaper_name=name or "ЗВУК",
            position_seconds=_time_to_seconds(row[start_idx], bpm=body.bpm),
            confirmed=True,
            color=color,
        )
        db.add(marker)
        created.append(marker)
    db.commit()
    _push_if_shared(ep_id, db)
    return db.query(Marker).filter(Marker.episode_id == ep_id).order_by(Marker.position_seconds).all()


@router.put("/markers/{marker_id}", response_model=MarkerOut)
def update_marker(marker_id: int, body: MarkerUpdate, db: Session = Depends(get_db)):
    marker = db.get(Marker, marker_id)
    if not marker:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(marker, k, v)
    db.commit()
    db.refresh(marker)
    _push_if_shared(marker.episode_id, db)
    return marker


@router.delete("/markers/{marker_id}", status_code=204)
def delete_marker(marker_id: int, db: Session = Depends(get_db)):
    marker = db.get(Marker, marker_id)
    if not marker:
        raise HTTPException(404)
    ep_id = marker.episode_id
    db.delete(marker)
    db.commit()
    _push_if_shared(ep_id, db)


@router.delete("/episodes/{ep_id}/markers", status_code=204)
def delete_all_markers(ep_id: int, db: Session = Depends(get_db)):
    db.query(Marker).filter(Marker.episode_id == ep_id).delete()
    db.commit()
    _push_if_shared(ep_id, db)


@router.get("/episodes/{ep_id}/export-reaper-csv")
def export_reaper_csv(ep_id: int, character_code: str | None = None, character_id: int | None = None, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    # character_code/character_id — the "actor" role workspace's "download
    # just my markers" button (see Character.code/id, resolved via
    # /titles/{id}/my-character), not the whole episode's marker set.
    from ..services.reaper_exporter import export_marker_csv
    csv_content = export_marker_csv(ep_id, db, position_format="time", character_code=character_code, character_id=character_id)

    suffix = f"_{character_code or character_id}" if character_code or character_id else ""
    return StreamingResponse(
        iter([csv_content.encode("utf-8")]),
        media_type="text/csv",
        headers={"Content-Disposition": _content_disposition(f"episode_{ep_id}_markers{suffix}.csv")},
    )


@router.get("/episodes/{ep_id}/export-reascript")
def export_reascript(ep_id: int, character_code: str | None = None, character_id: int | None = None, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    from ..services.reaper_exporter import export_reascript_lua
    lua_content = export_reascript_lua(ep_id, db, character_code=character_code, character_id=character_id)

    suffix = f"_{character_code or character_id}" if character_code or character_id else ""
    return StreamingResponse(
        iter([lua_content.encode("utf-8")]),
        media_type="text/plain",
        headers={"Content-Disposition": _content_disposition(f"episode_{ep_id}_setup{suffix}.lua")},
    )
