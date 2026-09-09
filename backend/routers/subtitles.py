import asyncio
import os
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Episode, SubtitleLine, Character, CharacterDubberMap, Dubber, SignStyle
from ..schemas import SubtitleLineCreate, SubtitleLineUpdate, SubtitleLineOut, AssImportRequest
from .. import job_manager


def _content_disposition(filename: str) -> str:
    """HTTP header VALUES must be latin-1/ASCII — a raw Cyrillic filename
    (e.g. a character's name) in Content-Disposition throws
    UnicodeEncodeError deep inside Starlette rather than a clean 4xx
    (confirmed live 2026-08-16, export-srt?character_id= on a Ukrainian
    character name). RFC 6266's filename* covers the real (UTF-8, percent-
    encoded) name for compliant clients; the plain filename= stays a safe
    ASCII-only fallback for anything that only understands that."""
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "download"
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename)}"

router = APIRouter(tags=["subtitles"])


@router.get("/episodes/{ep_id}/subtitle-lines", response_model=List[SubtitleLineOut])
def list_subtitle_lines(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    lines = db.query(SubtitleLine).filter(SubtitleLine.episode_id == ep_id).order_by(SubtitleLine.start_ms).all()
    result = []
    for line in lines:
        out = SubtitleLineOut.model_validate(line)
        if line.character:
            out.character_name = line.character.name
        result.append(out)
    return result


def _push_lines_if_shared(ep: Episode, db: Session) -> None:
    if ep.title.shared_id:
        from ..services import sync_service
        sync_service.push_subtitle_lines(ep.id, db)


@router.post("/episodes/{ep_id}/subtitle-lines", response_model=SubtitleLineOut, status_code=201)
def create_subtitle_line(ep_id: int, body: SubtitleLineCreate, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    line = SubtitleLine(episode_id=ep_id, **body.model_dump())
    db.add(line)
    db.commit()
    db.refresh(line)
    _push_lines_if_shared(ep, db)
    out = SubtitleLineOut.model_validate(line)
    if line.character:
        out.character_name = line.character.name
    return out


@router.put("/subtitle-lines/{line_id}", response_model=SubtitleLineOut)
def update_subtitle_line(line_id: int, body: SubtitleLineUpdate, db: Session = Depends(get_db)):
    line = db.get(SubtitleLine, line_id)
    if not line:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(line, k, v)
    # Адмін tab's translator status ("не взявся" -> "взявся") — subtitle_stage
    # alone can't tell these apart, it stays "translating" for both (see
    # Episode.translation_started_at's own comment).
    ep = line.episode
    just_started = ep and ep.subtitle_stage == "translating" and not ep.translation_started_at
    if just_started:
        import datetime as dt
        ep.translation_started_at = dt.datetime.utcnow()
    db.commit()
    db.refresh(line)
    _push_lines_if_shared(line.episode, db)
    if just_started and ep.title.shared_id:
        from ..services.sync_service import push_episode
        push_episode(ep.id, db)
    out = SubtitleLineOut.model_validate(line)
    if line.character:
        out.character_name = line.character.name
    return out


@router.delete("/subtitle-lines/{line_id}", status_code=204)
def delete_subtitle_line(line_id: int, db: Session = Depends(get_db)):
    line = db.get(SubtitleLine, line_id)
    if not line:
        raise HTTPException(404)
    ep = line.episode
    db.delete(line)
    db.commit()
    _push_lines_if_shared(ep, db)


@router.delete("/episodes/{ep_id}/subtitle-lines", status_code=204)
def delete_all_subtitle_lines(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    db.query(SubtitleLine).filter(SubtitleLine.episode_id == ep_id).delete()
    db.commit()
    if ep:
        _push_lines_if_shared(ep, db)


@router.put("/episodes/{ep_id}/subtitle-lines", response_model=List[SubtitleLineOut])
def replace_all_subtitle_lines(ep_id: int, body: List[SubtitleLineCreate], db: Session = Depends(get_db)):
    """Wholesale-replaces an episode's subtitle lines — used to persist an undo (Ctrl+Z)
    snapshot restore, since undo doesn't track which individual rows changed."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    db.query(SubtitleLine).filter(SubtitleLine.episode_id == ep_id).delete()
    db.flush()
    lines = [SubtitleLine(episode_id=ep_id, **item.model_dump()) for item in body]
    db.add_all(lines)
    db.commit()
    _push_lines_if_shared(ep, db)
    result = []
    for line in lines:
        db.refresh(line)
        out = SubtitleLineOut.model_validate(line)
        if line.character:
            out.character_name = line.character.name
        result.append(out)
    return result


@router.post("/episodes/{ep_id}/import-ass")
async def import_ass(ep_id: int, body: AssImportRequest, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    if not os.path.isfile(body.file_path):
        raise HTTPException(400, f"ASS file not found: {body.file_path}")

    job = job_manager.create_job("import_ass", episode_id=ep_id)

    from ..services.subtitle_parser import run_ass_import
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_ass_import(ep_id, body.file_path, r, body.preserve_assignments))
    )

    return {"job_id": job.id}


@router.get("/episodes/{ep_id}/export-srt")
def export_srt(ep_id: int, character_id: int | None = None, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    # character_id — the "actor" role workspace's "download just my lines"
    # button (see routers/characters.py's /titles/{id}/my-character, which
    # resolves which character(s) belong to the logged-in profile) — a
    # single plain .srt, not the whole studio's zip.
    if character_id is not None:
        from ..services.srt_exporter import export_srt_for_character
        try:
            filename, srt_bytes = export_srt_for_character(ep_id, character_id, db)
        except ValueError as e:
            raise HTTPException(404, str(e))
        return StreamingResponse(
            iter([srt_bytes]),
            media_type="text/plain",
            headers={"Content-Disposition": _content_disposition(filename)},
        )

    from ..services.srt_exporter import export_per_actor_srt
    zip_bytes = export_per_actor_srt(ep_id, db)

    return StreamingResponse(
        iter([zip_bytes]),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=episode_{ep_id}_srt.zip"},
    )


@router.get("/episodes/{ep_id}/ass-content")
def get_ass_content(ep_id: int, db: Session = Depends(get_db)):
    # Feeds the video player's JASSUB (libass) preview renderer — plain text
    # response, not a file download, and always live from the DB (see
    # srt_exporter.build_current_ass) so in-progress grid edits show up in
    # the preview without a separate export/save step.
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    from ..services.srt_exporter import build_current_ass
    return Response(content=build_current_ass(ep_id, db), media_type="text/plain; charset=utf-8")


@router.get("/episodes/{ep_id}/subtitle-stats")
def subtitle_stats(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    lines = db.query(SubtitleLine).filter(SubtitleLine.episode_id == ep_id).all()
    sign_style_names = {
        s.style_name for s in db.query(SignStyle).filter(SignStyle.title_id == ep.title_id).all()
    }

    stats: dict = {}
    for line in lines:
        if line.ass_style in sign_style_names:
            key = "-Текст"
        elif line.is_overlap:
            key = "-Перебивка"
        elif line.character:
            key = line.character.name
        else:
            key = "Без персонажа"

        if key not in stats:
            stats[key] = {"count": 0, "total": len(lines)}
        stats[key]["count"] += 1

    return {
        k: {"count": v["count"], "percent": round(v["count"] / max(v["total"], 1) * 100, 1)}
        for k, v in stats.items()
    }
