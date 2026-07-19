from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List

from ..database import get_db
from ..models import Title, Episode, Character, SignStyle
from ..schemas import TitleCreate, TitleUpdate, TitleOut, SignStylesUpdate

router = APIRouter(prefix="/titles", tags=["titles"])

DEFAULT_SIGN_STYLES = ["Sign", "Signs", "OP", "ED"]


@router.get("/", response_model=List[TitleOut])
def list_titles(db: Session = Depends(get_db)):
    titles = db.query(Title).all()
    result = []
    for t in titles:
        ep_count = db.query(func.count(Episode.id)).filter(Episode.title_id == t.id).scalar()
        out = TitleOut.model_validate(t)
        out.episode_count = ep_count or 0
        result.append(out)
    return result


@router.post("/", response_model=TitleOut, status_code=201)
def create_title(body: TitleCreate, db: Session = Depends(get_db)):
    title = Title(**body.model_dump())
    db.add(title)
    db.flush()
    # Seed default sign styles
    for style_name in DEFAULT_SIGN_STYLES:
        db.add(SignStyle(title_id=title.id, style_name=style_name))
    db.commit()
    db.refresh(title)
    out = TitleOut.model_validate(title)
    out.episode_count = 0
    return out


@router.get("/{title_id}", response_model=TitleOut)
def get_title(title_id: int, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    ep_count = db.query(func.count(Episode.id)).filter(Episode.title_id == title_id).scalar()
    out = TitleOut.model_validate(title)
    out.episode_count = ep_count or 0
    return out


@router.put("/{title_id}", response_model=TitleOut)
def update_title(title_id: int, body: TitleUpdate, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(title, k, v)
    db.commit()
    db.refresh(title)
    ep_count = db.query(func.count(Episode.id)).filter(Episode.title_id == title_id).scalar()
    out = TitleOut.model_validate(title)
    out.episode_count = ep_count or 0
    return out


@router.delete("/{title_id}", status_code=204)
def delete_title(title_id: int, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    db.delete(title)
    db.commit()


@router.get("/{title_id}/sign-styles")
def get_sign_styles(title_id: int, db: Session = Depends(get_db)):
    styles = db.query(SignStyle).filter(SignStyle.title_id == title_id).all()
    return {"title_id": title_id, "style_names": [s.style_name for s in styles]}


@router.put("/{title_id}/sign-styles")
def update_sign_styles(title_id: int, body: SignStylesUpdate, db: Session = Depends(get_db)):
    db.query(SignStyle).filter(SignStyle.title_id == title_id).delete()
    for name in body.style_names:
        db.add(SignStyle(title_id=title_id, style_name=name.strip()))
    db.commit()
    return {"title_id": title_id, "style_names": body.style_names}
