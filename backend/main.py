"""FastAPI backend for the Segment Editor application."""
import os
from pathlib import Path
from typing import Optional

import aiofiles
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from csv_service import CSVService

# Configuration
PROJECTS_DIR = Path(os.environ.get(
    "SEGMENT_EDITOR_PROJECTS_DIR",
    "/storage6/dubbing_projects"
))

# Cache of CSVService instances per project
_project_services: dict[str, CSVService] = {}


def get_service(project_name: str) -> CSVService:
    """Get or create a CSVService for the given project."""
    project_path = PROJECTS_DIR / project_name
    segments_path = project_path / "transcriptions" / "segments.csv"

    if not segments_path.exists():
        raise HTTPException(status_code=404, detail=f"Project '{project_name}' not found")

    # Check if cached service still has valid path (handles project rename)
    if project_name in _project_services:
        cached_service = _project_services[project_name]
        if cached_service.project_path == project_path:
            return cached_service
        # Path changed (project was renamed), invalidate cache
        del _project_services[project_name]

    service = CSVService(str(project_path))
    _project_services[project_name] = service
    return service


# Create FastAPI app
app = FastAPI(title="Segment Editor API")

# CORS middleware for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Pydantic models
class SegmentUpdate(BaseModel):
    """Model for segment update requests."""
    start_sec: Optional[float] = None
    end_sec: Optional[float] = None
    text: Optional[str] = None


class SegmentResponse(BaseModel):
    """Model for segment response."""
    segment_id: int
    chunk_id: int
    start_sec: float
    end_sec: float
    text: str
    language: Optional[str] = None
    gap_type: Optional[str] = None
    speaker: Optional[str] = None


# API Routes

@app.get("/api/projects")
async def list_projects():
    """List all available projects with duration."""
    import pandas as pd
    projects = []
    if PROJECTS_DIR.exists():
        for d in sorted(PROJECTS_DIR.iterdir()):
            if d.is_dir() and (d / "transcriptions" / "segments.csv").exists():
                duration = 0.0
                chunks_meta = d / "chunks" / "chunks_metadata.csv"
                if chunks_meta.exists():
                    try:
                        df = pd.read_csv(chunks_meta)
                        duration = float(df["End Time (s)"].max())
                    except Exception:
                        pass
                projects.append({"name": d.name, "duration": duration})
    return {"projects": projects, "total": len(projects)}


@app.get("/api/{project_name}/project")
async def get_project_info(project_name: str):
    """Get project information."""
    get_service(project_name)  # validates project exists
    project_path = PROJECTS_DIR / project_name
    return {
        "name": project_path.name,
        "path": str(project_path)
    }


@app.get("/api/{project_name}/segments")
async def get_segments(project_name: str, chunk_id: Optional[int] = None):
    """Get all segments, optionally filtered by chunk_id."""
    service = get_service(project_name)
    if chunk_id is not None:
        segments = service.get_segments_by_chunk(chunk_id)
    else:
        segments = service.get_all_segments()
    return {"segments": segments, "total": len(segments)}


@app.get("/api/{project_name}/segments/{segment_id}")
async def get_segment(project_name: str, segment_id: int):
    """Get a specific segment by ID."""
    service = get_service(project_name)
    segment = service.get_segment(segment_id)
    if segment is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    return segment


@app.put("/api/{project_name}/segments/{segment_id}")
async def update_segment(project_name: str, segment_id: int, update: SegmentUpdate):
    """Update a segment's start_sec, end_sec, or text."""
    service = get_service(project_name)
    updates = {}
    if update.start_sec is not None:
        updates["start_sec"] = update.start_sec
    if update.end_sec is not None:
        updates["end_sec"] = update.end_sec
    if update.text is not None:
        updates["text"] = update.text

    if not updates:
        raise HTTPException(status_code=400, detail="No valid updates provided")

    result = service.update_segment(segment_id, updates)
    if result is None:
        raise HTTPException(status_code=404, detail="Segment not found")

    return {"success": True, "segment": result}


@app.delete("/api/{project_name}/segments/{segment_id}")
async def delete_segment(project_name: str, segment_id: int):
    """Delete a segment from the CSV."""
    service = get_service(project_name)
    result = service.delete_segment(segment_id)
    if not result:
        raise HTTPException(status_code=404, detail="Segment not found")
    return {"success": True, "deleted_segment_id": segment_id}


@app.get("/api/{project_name}/chunks")
async def get_chunks(project_name: str):
    """Get all chunks metadata."""
    service = get_service(project_name)
    chunks = service.get_all_chunks()
    return {"chunks": chunks, "total": len(chunks)}


@app.get("/api/{project_name}/chunks/{chunk_id}")
async def get_chunk(project_name: str, chunk_id: int):
    """Get a specific chunk by ID."""
    service = get_service(project_name)
    chunk = service.get_chunk(chunk_id)
    if chunk is None:
        raise HTTPException(status_code=404, detail="Chunk not found")
    return chunk


@app.get("/api/{project_name}/audio/{chunk_id}")
async def stream_audio(project_name: str, chunk_id: int, request: Request):
    """Stream audio file with Range header support for seeking."""
    service = get_service(project_name)
    chunk_path = service.get_chunk_file_path(chunk_id)
    if chunk_path is None or not chunk_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")

    file_size = chunk_path.stat().st_size

    # Check for Range header
    range_header = request.headers.get("range")

    if range_header:
        # Parse range header (e.g., "bytes=0-1023")
        try:
            range_spec = range_header.replace("bytes=", "")
            range_parts = range_spec.split("-")
            start = int(range_parts[0]) if range_parts[0] else 0
            end = int(range_parts[1]) if range_parts[1] else file_size - 1
        except (ValueError, IndexError):
            raise HTTPException(status_code=416, detail="Invalid Range header")

        # Ensure valid range
        if start >= file_size or end >= file_size or start > end:
            raise HTTPException(
                status_code=416,
                detail="Range not satisfiable",
                headers={"Content-Range": f"bytes */{file_size}"}
            )

        content_length = end - start + 1

        async def iterfile():
            async with aiofiles.open(chunk_path, "rb") as f:
                await f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk_size = min(8192, remaining)
                    data = await f.read(chunk_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iterfile(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
            }
        )

    # No range header - return full file
    return FileResponse(
        chunk_path,
        media_type="video/mp4",
        headers={"Accept-Ranges": "bytes"}
    )


# Mount frontend static files (must be last)
frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="frontend")
