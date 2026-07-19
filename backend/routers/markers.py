import io
import csv
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Marker, Episode
from ..schemas import MarkerCreate, MarkerUpdate, MarkerOut

router = APIRouter(tags=["markers"])


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
    return marker


@router.put("/markers/{marker_id}", response_model=MarkerOut)
def update_marker(marker_id: int, body: MarkerUpdate, db: Session = Depends(get_db)):
    marker = db.get(Marker, marker_id)
    if not marker:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(marker, k, v)
    db.commit()
    db.refresh(marker)
    return marker


@router.delete("/markers/{marker_id}", status_code=204)
def delete_marker(marker_id: int, db: Session = Depends(get_db)):
    marker = db.get(Marker, marker_id)
    if not marker:
        raise HTTPException(404)
    db.delete(marker)
    db.commit()


@router.get("/episodes/{ep_id}/export-reaper-csv")
def export_reaper_csv(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    from ..services.reaper_exporter import export_marker_csv
    csv_content = export_marker_csv(ep_id, db, position_format="time")

    return StreamingResponse(
        iter([csv_content.encode("utf-8")]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=episode_{ep_id}_markers.csv"},
    )


@router.get("/episodes/{ep_id}/export-reascript")
def export_reascript(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)

    from ..services.reaper_exporter import export_reascript_lua
    lua_content = export_reascript_lua(ep_id, db)

    return StreamingResponse(
        iter([lua_content.encode("utf-8")]),
        media_type="text/plain",
        headers={"Content-Disposition": f"attachment; filename=episode_{ep_id}_setup.lua"},
    )
