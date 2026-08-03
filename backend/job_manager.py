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

from .services.power_share_service import app_logger


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
    # Only a still-in-flight job can be cancelled — without this guard, a
    # cancel request that lands after the job already finished (a stray
    # double-click, or a race between the "complete" WS broadcast and the
    # cancel button) flips an already-successful result's status back to
    # "cancelled", which the UI then displays over real completed work
    # (confirmed live: DELETE on a completed mux_audio job turned its
    # status from "complete" to "cancelled" despite the render having
    # actually succeeded on disk).
    if job and job.status in ("pending", "running"):
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
    app_logger.info("job created id=%s type=%s episode_id=%s", job.id, job_type, episode_id)
    return job


async def run_job(
    loop: asyncio.AbstractEventLoop,
    job: Job,
    fn: Callable[["ProgressReporter"], Any],
):
    """Run `fn` in the thread pool, with progress callbacks feeding back to the WS."""
    job.status = "running"
    app_logger.info("job started id=%s type=%s episode_id=%s", job.id, job.type, job.episode_id)
    reporter = ProgressReporter(job, loop)

    def _task():
        try:
            result = fn(reporter)
            if job.cancel_flag:
                # fn() returned normally despite a cancel request — happens
                # whenever the underlying work has no cooperative cancel
                # checkpoint between its last one and actually finishing (a
                # single-model vocal separation has no callback INSIDE
                # audio-separator's own separate() call, only between
                # ensemble models). Without this branch, no WS event was ever
                # sent for this job: the frontend's copy of the job object
                # never left status "running", so its progress chip stayed
                # frozen at whatever percent it showed when Cancel was
                # clicked — looking exactly like a hang, forever — even
                # though the backend's own job record already said
                # "cancelled" (confirmed live: percent frozen at 38%, no
                # further WS traffic for that job at all).
                app_logger.info(
                    "job cancelled (ran to completion after cancel) id=%s type=%s episode_id=%s",
                    job.id, job.type, job.episode_id,
                )
                asyncio.run_coroutine_threadsafe(
                    _broadcast({"type": "cancelled", "job_id": job.id}),
                    loop,
                )
                return None
            job.status = "complete"
            job.percent = 100
            job.result = result or {}
            app_logger.info("job complete id=%s type=%s episode_id=%s", job.id, job.type, job.episode_id)
            return result
        except Exception as exc:
            # A user-cancelled job surfaces here too — either as this
            # module's CancelledError (raised by ProgressReporter.update
            # once cancel_job() has flipped cancel_flag) or as a plain
            # exception the worker code itself raises upon noticing
            # is_cancelled() (e.g. separator_service.separate_file's
            # RuntimeError("Скасовано")). Checking cancel_flag rather than
            # the exception type catches both uniformly, so a cancellation
            # is reported as "cancelled", not as a failure.
            if job.cancel_flag:
                job.status = "cancelled"
                app_logger.info(
                    "job cancelled id=%s type=%s episode_id=%s", job.id, job.type, job.episode_id,
                )
                asyncio.run_coroutine_threadsafe(
                    _broadcast({"type": "cancelled", "job_id": job.id}),
                    loop,
                )
                return None

            job.status = "error"
            job.message = str(exc)
            # exception() (not error()) so the full traceback lands in
            # app.log — without it, a background-thread failure (e.g.
            # vocal separation blowing up on a bad model file) only ever
            # surfaces as a one-line str(exc) with no stack, which is
            # frequently useless on its own ("list index out of range" etc).
            app_logger.exception(
                "job FAILED id=%s type=%s episode_id=%s: %s", job.id, job.type, job.episode_id, exc,
            )
            asyncio.run_coroutine_threadsafe(
                _broadcast({"type": "error", "job_id": job.id, "error": str(exc)}),
                loop,
            )
            raise

    future = loop.run_in_executor(_executor, _task)
    try:
        await future
        if job.status == "complete":
            await _broadcast({"type": "complete", "job_id": job.id, "data": job.result})
    except Exception as exc:
        # The exception already got a full traceback logged inside _task
        # above (or, for a cancellation, is expected) — this outer catch
        # exists only so `await future` re-raising doesn't crash the
        # asyncio task run_job was scheduled on, not to swallow anything
        # silently. Still log at debug level so a truly unexpected failure
        # here (e.g. the broadcast itself throwing) isn't invisible.
        if not isinstance(exc, CancelledError):
            app_logger.debug("run_job outer catch id=%s: %r", job.id, exc)


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
