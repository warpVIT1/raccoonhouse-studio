from fastapi import APIRouter, HTTPException
from typing import List
from .. import job_manager
from ..schemas import JobStatusOut

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/", response_model=List[JobStatusOut])
def list_jobs():
    jobs = job_manager.list_jobs()
    return [
        JobStatusOut(
            id=j.id, type=j.type, status=j.status, percent=j.percent,
            message=j.message, episode_id=j.episode_id, result=j.result,
        )
        for j in jobs
    ]


@router.get("/{job_id}", response_model=JobStatusOut)
def get_job(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404)
    return JobStatusOut(
        id=job.id, type=job.type, status=job.status, percent=job.percent,
        message=job.message, episode_id=job.episode_id, result=job.result,
    )


@router.delete("/{job_id}", status_code=204)
def cancel_job(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(404)
    job_manager.cancel_job(job_id)
