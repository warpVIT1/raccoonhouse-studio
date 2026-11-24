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


_CHAR_CACHE: dict[str, tuple[float, list[dict]]] = {}
_CHAR_CACHE_TTL = 6 * 3600


def get_anime_characters(slug: str) -> list[dict]:
    """All characters of one Hikka anime (name_ua/en/ja, synonyms, image,
    main flag), paginated and cached in memory for a few hours - the roles
    tab can be re-opened repeatedly while casting."""
    import time
    cached = _CHAR_CACHE.get(slug)
    if cached and time.time() - cached[0] < _CHAR_CACHE_TTL:
        return cached[1]
    out: list[dict] = []
    page = 1
    while page <= 20:
        resp = requests.get(
            f"{HIKKA_BASE}/anime/{slug}/characters",
            params={"page": page, "size": 100},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        for item in data.get("list", []):
            ch = item.get("character") or {}
            out.append({
                "slug": ch.get("slug"),
                "name_ua": ch.get("name_ua"),
                "name_en": ch.get("name_en"),
                "name_ja": ch.get("name_ja"),
                "synonyms": ch.get("synonyms") or [],
                "image": ch.get("image"),
                "main": bool(item.get("main")),
                "source": "hikka",
            })
        pages = (data.get("pagination") or {}).get("pages") or 1
        if page >= pages:
            break
        page += 1
    _CHAR_CACHE[slug] = (time.time(), out)
    return out
