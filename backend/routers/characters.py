from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Optional

from ..database import get_db
from ..models import Character, Dubber, CharacterDubberMap
from ..schemas import CharacterCreate, CharacterOut, DubberCreate, DubberOut, CharacterDubberMapCreate

router = APIRouter(tags=["characters"])


@router.get("/characters", response_model=List[CharacterOut])
def list_characters(title_id: Optional[int] = None, db: Session = Depends(get_db)):
    q = db.query(Character)
    if title_id:
        q = q.filter(Character.title_id == title_id)
    chars = q.all()
    result = []
    for c in chars:
        out = CharacterOut.model_validate(c)
        # Resolve dubber
        mapping = db.query(CharacterDubberMap).filter(
            CharacterDubberMap.character_id == c.id,
            CharacterDubberMap.title_id == c.title_id,
        ).first()
        if mapping:
            dubber = db.get(Dubber, mapping.dubber_id)
            out.dubber_id = mapping.dubber_id
            out.dubber_name = dubber.name if dubber else None
        result.append(out)
    return result


@router.post("/characters", response_model=CharacterOut, status_code=201)
def create_character(body: CharacterCreate, db: Session = Depends(get_db)):
    char = Character(title_id=body.title_id, name=body.name, code=body.code)
    db.add(char)
    db.flush()
    if body.dubber_id:
        db.add(CharacterDubberMap(character_id=char.id, dubber_id=body.dubber_id, title_id=body.title_id))
    db.commit()
    db.refresh(char)
    out = CharacterOut.model_validate(char)
    if body.dubber_id:
        dubber = db.get(Dubber, body.dubber_id)
        out.dubber_id = body.dubber_id
        out.dubber_name = dubber.name if dubber else None
    return out


@router.put("/characters/{char_id}", response_model=CharacterOut)
def update_character(char_id: int, body: CharacterCreate, db: Session = Depends(get_db)):
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404)
    char.name = body.name
    char.code = body.code
    if body.dubber_id is not None:
        mapping = db.query(CharacterDubberMap).filter(
            CharacterDubberMap.character_id == char_id,
            CharacterDubberMap.title_id == body.title_id,
        ).first()
        if mapping:
            mapping.dubber_id = body.dubber_id
        else:
            db.add(CharacterDubberMap(character_id=char_id, dubber_id=body.dubber_id, title_id=body.title_id))
    db.commit()
    db.refresh(char)
    out = CharacterOut.model_validate(char)
    if body.dubber_id:
        dubber = db.get(Dubber, body.dubber_id)
        out.dubber_id = body.dubber_id
        out.dubber_name = dubber.name if dubber else None
    return out


@router.delete("/characters/{char_id}", status_code=204)
def delete_character(char_id: int, db: Session = Depends(get_db)):
    char = db.get(Character, char_id)
    if not char:
        raise HTTPException(404)
    db.delete(char)
    db.commit()


@router.get("/dubbers", response_model=List[DubberOut])
def list_dubbers(db: Session = Depends(get_db)):
    return db.query(Dubber).all()


@router.post("/dubbers", response_model=DubberOut, status_code=201)
def create_dubber(body: DubberCreate, db: Session = Depends(get_db)):
    # Upsert by name
    existing = db.query(Dubber).filter(Dubber.name == body.name).first()
    if existing:
        return existing
    dubber = Dubber(name=body.name)
    db.add(dubber)
    db.commit()
    db.refresh(dubber)
    return dubber


@router.post("/character-dubber-map", status_code=204)
def set_dubber_mapping(body: CharacterDubberMapCreate, db: Session = Depends(get_db)):
    existing = db.query(CharacterDubberMap).filter(
        CharacterDubberMap.character_id == body.character_id,
        CharacterDubberMap.title_id == body.title_id,
    ).first()
    if existing:
        existing.dubber_id = body.dubber_id
    else:
        db.add(CharacterDubberMap(**body.model_dump()))
    db.commit()
