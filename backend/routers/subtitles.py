import asyncio
import os
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Episode, SubtitleLine, Character, CharacterDubberMap, Dubber, SignStyle
from ..schemas import SubtitleLineCreate, SubtitleLineUpdate, SubtitleLineOut, AssImportRequest
from .. import job_manager

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


@router.post("/episodes/{ep_id}/subtitle-lines", response_model=SubtitleLineOut, status_code=201)
def create_subtitle_line(ep_id: int, body: SubtitleLineCreate, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    line = SubtitleLine(episode_id=ep_id, **body.model_dump())
    db.add(line)
    db.commit()
    db.refresh(line)
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
    db.commit()
    db.refresh(line)
    out = SubtitleLineOut.model_validate(line)
    if line.character:
        out.character_name = line.character.name
    return out


@router.delete("/subtitle-lines/{line_id}", status_code=204)
def delete_subtitle_line(line_id: int, db: Session = Depends(get_db)):
    line = db.get(SubtitleLine, line_id)
    if not line:
        raise HTTPException(404)
    db.delete(line)
    db.commit()


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
        job_manager.run_job(loop, job, lambda r: run_ass_import(ep_id, body.file_path, r))
    )

    return {"job_id": job.id}


@router.get("/episodes/{ep_id}/export-srt")
def export_srt(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    from ..services.srt_exporter import export_per_actor_srt
    zip_bytes = export_per_actor_srt(ep_id, db)

    return StreamingResponse(
        iter([zip_bytes]),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=episode_{ep_id}_srt.zip"},
    )


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
