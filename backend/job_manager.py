"""
Central in-process job manager. Jobs run in a thread pool and push
progress events over WebSocket. All long-running operations (ffmpeg,
audio-separator, VAD, export) use this to report progress.
"""
import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Coroutine, Optional
from dataclasses import dataclass, field


@dataclass
class Job:
    id: str
    type: str
    status: str = "pending"   # pending / running / complete / error / cancelled
    percent: int = 0
    message: str = ""
    episode_id: Optional[int] = None
    result: dict = field(default_factory=dict)
    cancel_flag: bool = False


_jobs: dict[str, Job] = {}
_executor = ThreadPoolExecutor(max_workers=4)
_ws_broadcast: Optional[Callable[[dict], Coroutine]] = None


def set_broadcast(fn: Callable[[dict], Coroutine]):
    global _ws_broadcast
    _ws_broadcast = fn


def get_job(job_id: str) -> Optional[Job]:
    return _jobs.get(job_id)


def list_jobs() -> list[Job]:
    return list(_jobs.values())


def cancel_job(job_id: str):
    job = _jobs.get(job_id)
    if job:
        job.cancel_flag = True
        job.status = "cancelled"


def cancel_jobs_for_episode(episode_id: int) -> list[str]:
    """Cancels every still-running job tied to this episode — used when the
    episode itself is deleted, so a stale progress percent doesn't keep
    showing in the title bar / episode tile for a job whose target no longer
    exists. Cancellation is cooperative (see ProgressReporter.update), so an
    in-flight ffmpeg/audio-separator subprocess still runs to completion, but
    the UI stops reflecting it as this episode's job."""
    ids = []
    for job in _jobs.values():
        if job.episode_id == episode_id and job.status in ("pending", "running"):
            job.cancel_flag = True
            job.status = "cancelled"
            ids.append(job.id)
    return ids


async def _broadcast(data: dict):
    if _ws_broadcast:
        await _ws_broadcast(data)


def create_job(job_type: str, episode_id: Optional[int] = None) -> Job:
    job = Job(id=str(uuid.uuid4()), type=job_type, episode_id=episode_id)
    _jobs[job.id] = job
    return job


async def run_job(
    loop: asyncio.AbstractEventLoop,
    job: Job,
    fn: Callable[["ProgressReporter"], Any],
):
    """Run `fn` in the thread pool, with progress callbacks feeding back to the WS."""
    job.status = "running"
    reporter = ProgressReporter(job, loop)

    def _task():
        try:
            result = fn(reporter)
            if not job.cancel_flag:
                job.status = "complete"
                job.percent = 100
                job.result = result or {}
            return result
        except Exception as exc:
            job.status = "error"
            job.message = str(exc)
            asyncio.run_coroutine_threadsafe(
                _broadcast({"type": "error", "job_id": job.id, "error": str(exc)}),
                loop,
            )
            raise

    future = loop.run_in_executor(_executor, _task)
    try:
        await future
        await _broadcast({"type": "complete", "job_id": job.id, "data": job.result})
    except Exception:
        pass


class ProgressReporter:
    """Passed into worker threads to push progress events."""

    def __init__(self, job: Job, loop: asyncio.AbstractEventLoop):
        self.job = job
        self.loop = loop

    def update(self, percent: int, message: str = ""):
        if self.job.cancel_flag:
            raise CancelledError()
        self.job.percent = percent
        self.job.message = message
        asyncio.run_coroutine_threadsafe(
            _broadcast({"type": "progress", "job_id": self.job.id, "percent": percent, "message": message}),
            self.loop,
        )

    @property
    def cancelled(self) -> bool:
        return self.job.cancel_flag


class CancelledError(Exception):
    pass
