"""
Hikka (https://hikka.io) catalog integration — lets the user search for a title's
poster art by name instead of hunting for an image file manually.

API docs: https://api.hikka.io/docs
POST /anime — catalog search, body {"query": "..."}. Poster images are served
directly from Hikka's CDN (cdn.hikka.io) and are NOT downloaded/cached locally —
the app stores the CDN URL as-is and loads it live, so posters need internet access.
"""
import requests

HIKKA_BASE = "https://api.hikka.io"


def search_anime(query: str, size: int = 12) -> list[dict]:
    """Search Hikka's catalog by title. Returns simplified candidate dicts."""
    if not query.strip():
        return []
    resp = requests.post(
        f"{HIKKA_BASE}/anime",
        params={"page": 1, "size": size},
        json={"query": query.strip()},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    results = []
    for item in data.get("list", []):
        results.append({
            "slug": item.get("slug"),
            "title_ua": item.get("title_ua"),
            "title_en": item.get("title_en"),
            "title_ja": item.get("title_ja"),
            "image": item.get("image"),
            "episodes_total": item.get("episodes_total"),
            "status": item.get("status"),
        })
    return results
