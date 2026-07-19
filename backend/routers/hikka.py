from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Title
from ..schemas import HikkaAnimeResult, PosterFromUrlRequest, TitleOut
from ..services import hikka_service

router = APIRouter(tags=["hikka"])


@router.get("/hikka/search", response_model=List[HikkaAnimeResult])
def search_hikka(query: str):
    try:
        return hikka_service.search_anime(query)
    except Exception as exc:
        raise HTTPException(502, f"Hikka API request failed: {exc}")


@router.post("/titles/{title_id}/poster-from-url", response_model=TitleOut)
def set_poster_from_url(title_id: int, body: PosterFromUrlRequest, db: Session = Depends(get_db)):
    """Store the Hikka CDN URL directly — poster loads live from the internet,
    nothing is downloaded or cached on disk."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    title.poster_path = body.image_url
    db.commit()
    db.refresh(title)
    return TitleOut.model_validate(title)
