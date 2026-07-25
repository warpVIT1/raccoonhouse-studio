from sqlalchemy.orm import Session

from ..models import Title


def bump_title_in_progress(db: Session, title_id: int) -> None:
    """Advances a title from 'new' to 'in_progress' the moment any of its
    episodes gets a first vocal isolation — 'new' means nothing has started
    yet, 'in_progress' means real work is underway. Called from every place
    an episode's status becomes 'vocal_isolated' (local separation, batch
    pick, power-share, distributed). Never touches 'done' (that's a
    deliberate manual mark, see TitlesPage.tsx) or moves status backward."""
    title = db.get(Title, title_id)
    if title and title.status == "new":
        title.status = "in_progress"
