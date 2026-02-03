#!/usr/bin/env python3
"""
Segment Editor Server Startup Script

Usage:
    python run.py [--port PORT] [--host HOST] [--project PATH]

Example:
    python run.py --port 8765 --host 0.0.0.0 --project /storage6/dubbing_projects/fp
"""

import argparse
import os
import sys
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent / "backend"
sys.path.insert(0, str(backend_path))


def main():
    parser = argparse.ArgumentParser(description="Segment Editor Server")
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port to run the server on (default: 8765)"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0 for all interfaces)"
    )
    parser.add_argument(
        "--project",
        type=str,
        default="/storage6/dubbing_projects/fp",
        help="Path to the dubbing project"
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development"
    )
    args = parser.parse_args()

    # Set environment variable for project path
    os.environ["SEGMENT_EDITOR_PROJECT_PATH"] = args.project

    # Verify project exists
    project_path = Path(args.project)
    segments_path = project_path / "transcriptions" / "segments.csv"
    chunks_path = project_path / "chunks"

    if not segments_path.exists():
        print(f"Error: segments.csv not found at {segments_path}")
        sys.exit(1)

    if not chunks_path.exists():
        print(f"Error: chunks directory not found at {chunks_path}")
        sys.exit(1)

    print(f"Starting Segment Editor...")
    print(f"  Project: {args.project}")
    print(f"")
    print(f"Open in your browser:")
    print(f"")
    print(f"  http://localhost:{args.port}")
    print(f"")
    print(f"Press Ctrl+C to stop")
    print(f"")

    # Run uvicorn
    import uvicorn
    uvicorn.run(
        "main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
