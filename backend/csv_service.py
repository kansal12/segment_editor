"""CSV service for reading and writing segment data."""
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd
import math


def clean_dict(d: dict) -> dict:
    """Convert NaN values to None for JSON serialization."""
    return {
        k: (None if isinstance(v, float) and math.isnan(v) else v)
        for k, v in d.items()
    }


class CSVService:
    """Service for managing segments.csv and chunks_metadata.csv."""

    def __init__(self, project_path: str):
        self.project_path = Path(project_path)
        self.segments_path = self.project_path / "transcriptions" / "segments.csv"
        self.chunks_meta_path = self.project_path / "chunks" / "chunks_metadata.csv"
        self.backup_dir = self.project_path / "transcriptions" / "backups"

        # Cache for segments DataFrame
        self._segments_df: Optional[pd.DataFrame] = None
        self._chunks_df: Optional[pd.DataFrame] = None

    def load_segments(self, force_reload: bool = False) -> pd.DataFrame:
        """Load segments from CSV file."""
        if self._segments_df is None or force_reload:
            self._segments_df = pd.read_csv(self.segments_path)
        return self._segments_df.copy()

    def load_chunks(self, force_reload: bool = False) -> pd.DataFrame:
        """Load chunks metadata from CSV file."""
        if self._chunks_df is None or force_reload:
            self._chunks_df = pd.read_csv(self.chunks_meta_path)
        return self._chunks_df.copy()

    def get_segments_by_chunk(self, chunk_id: int) -> list[dict]:
        """Get all segments for a specific chunk."""
        df = self.load_segments()
        chunk_segments = df[df["chunk_id"] == chunk_id]
        return [clean_dict(d) for d in chunk_segments.to_dict(orient="records")]

    def get_segment(self, segment_id: int) -> Optional[dict]:
        """Get a specific segment by ID."""
        df = self.load_segments()
        segment = df[df["segment_id"] == segment_id]
        if segment.empty:
            return None
        return clean_dict(segment.iloc[0].to_dict())

    def get_all_segments(self) -> list[dict]:
        """Get all segments."""
        df = self.load_segments()
        return [clean_dict(d) for d in df.to_dict(orient="records")]

    def get_all_chunks(self) -> list[dict]:
        """Get all chunks metadata with normalized column names."""
        df = self.load_chunks()
        # Normalize column names
        chunks = []
        for _, row in df.iterrows():
            chunks.append({
                "chunk_id": int(row["Chunk ID"]),
                "file_path": row["File Path"],
                "start_time": float(row["Start Time (s)"]),
                "end_time": float(row["End Time (s)"]),
            })
        return chunks

    def get_chunk(self, chunk_id: int) -> Optional[dict]:
        """Get a specific chunk by ID."""
        chunks = self.get_all_chunks()
        for chunk in chunks:
            if chunk["chunk_id"] == chunk_id:
                return chunk
        return None

    def update_segment(self, segment_id: int, updates: dict) -> Optional[dict]:
        """Update a segment and save to CSV."""
        df = self.load_segments(force_reload=True)  # Force reload to get latest

        idx = df[df["segment_id"] == segment_id].index
        if len(idx) == 0:
            return None

        # Update allowed fields
        allowed_fields = {"start_sec", "end_sec", "text"}
        for key, value in updates.items():
            if key in allowed_fields and key in df.columns:
                df.loc[idx[0], key] = value

        # Save with backup
        self._save_with_backup(df)

        # Update cache
        self._segments_df = df

        return clean_dict(df.loc[idx[0]].to_dict())

    def delete_segment(self, segment_id: int) -> bool:
        """Delete a segment from the CSV."""
        df = self.load_segments(force_reload=True)

        idx = df[df["segment_id"] == segment_id].index
        if len(idx) == 0:
            return False

        # Remove the segment
        df = df.drop(idx[0])

        # Save with backup
        self._save_with_backup(df)

        # Update cache
        self._segments_df = df

        return True

    def _save_with_backup(self, df: pd.DataFrame):
        """Save DataFrame to CSV with automatic backup."""
        # Create backup directory if needed
        self.backup_dir.mkdir(parents=True, exist_ok=True)

        # Create backup with timestamp
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = self.backup_dir / f"segments_{timestamp}.csv"

        # Copy current file to backup
        if self.segments_path.exists():
            shutil.copy2(self.segments_path, backup_path)

        # Write to temp file first
        temp_path = self.segments_path.with_suffix(".tmp")
        df.to_csv(temp_path, index=False)

        # Atomic rename
        temp_path.replace(self.segments_path)

    def get_chunk_file_path(self, chunk_id: int) -> Optional[Path]:
        """Get the file path for a chunk's audio file."""
        chunk = self.get_chunk(chunk_id)
        if chunk:
            return Path(chunk["file_path"])
        return None
