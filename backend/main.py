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
PROJECT_PATH = os.environ.get(
    "SEGMENT_EDITOR_PROJECT_PATH",
    "/storage6/dubbing_projects/fp"
)

# Initialize service
csv_service = CSVService(PROJECT_PATH)

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

@app.get("/api/segments")
async def get_segments(chunk_id: Optional[int] = None):
    """Get all segments, optionally filtered by chunk_id."""
    if chunk_id is not None:
        segments = csv_service.get_segments_by_chunk(chunk_id)
    else:
        segments = csv_service.get_all_segments()
    return {"segments": segments, "total": len(segments)}


@app.get("/api/segments/{segment_id}")
async def get_segment(segment_id: int):
    """Get a specific segment by ID."""
    segment = csv_service.get_segment(segment_id)
    if segment is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    return segment


@app.put("/api/segments/{segment_id}")
async def update_segment(segment_id: int, update: SegmentUpdate):
    """Update a segment's start_sec, end_sec, or text."""
    updates = {}
    if update.start_sec is not None:
        updates["start_sec"] = update.start_sec
    if update.end_sec is not None:
        updates["end_sec"] = update.end_sec
    if update.text is not None:
        updates["text"] = update.text

    if not updates:
        raise HTTPException(status_code=400, detail="No valid updates provided")

    result = csv_service.update_segment(segment_id, updates)
    if result is None:
        raise HTTPException(status_code=404, detail="Segment not found")

    return {"success": True, "segment": result}


@app.delete("/api/segments/{segment_id}")
async def delete_segment(segment_id: int):
    """Delete a segment from the CSV."""
    result = csv_service.delete_segment(segment_id)
    if not result:
        raise HTTPException(status_code=404, detail="Segment not found")
    return {"success": True, "deleted_segment_id": segment_id}


@app.get("/api/chunks")
async def get_chunks():
    """Get all chunks metadata."""
    chunks = csv_service.get_all_chunks()
    return {"chunks": chunks, "total": len(chunks)}


@app.get("/api/chunks/{chunk_id}")
async def get_chunk(chunk_id: int):
    """Get a specific chunk by ID."""
    chunk = csv_service.get_chunk(chunk_id)
    if chunk is None:
        raise HTTPException(status_code=404, detail="Chunk not found")
    return chunk


@app.get("/api/audio/{chunk_id}")
async def stream_audio(chunk_id: int, request: Request):
    """Stream audio file with Range header support for seeking."""
    chunk_path = csv_service.get_chunk_file_path(chunk_id)
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
