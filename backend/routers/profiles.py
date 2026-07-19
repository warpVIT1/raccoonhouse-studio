from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Profile, AppSettings
from ..schemas import ProfileCreate, ProfileOut

router = APIRouter(tags=["profiles"])


@router.get("/profiles", response_model=List[ProfileOut])
def list_profiles(db: Session = Depends(get_db)):
    return db.query(Profile).all()


@router.post("/profiles", response_model=ProfileOut, status_code=201)
def create_profile(body: ProfileCreate, db: Session = Depends(get_db)):
    profile = Profile(**body.model_dump())
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@router.put("/profiles/{profile_id}", response_model=ProfileOut)
def update_profile(profile_id: int, body: ProfileCreate, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404)
    for k, v in body.model_dump().items():
        setattr(profile, k, v)
    db.commit()
    db.refresh(profile)
    return profile


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404)
    db.delete(profile)
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id == profile_id:
        settings.active_profile_id = None
    db.commit()


@router.post("/profiles/{profile_id}/activate", response_model=ProfileOut)
def activate_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404)
    settings = db.get(AppSettings, 1)
    if not settings:
        settings = AppSettings(id=1)
        db.add(settings)
    settings.active_profile_id = profile_id
    db.commit()
    return profile
