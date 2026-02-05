#!/usr/bin/env python3
"""
Segment Editor Server Startup Script

Usage:
    python run.py [--port PORT] [--host HOST] [--projects-dir PATH]

Example:
    python run.py --projects-dir /storage6/dubbing_projects
"""

import argparse
import os
import sys
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent / "backend"
sys.path.insert(0, str(backend_path))

NGINX_DOMAIN = "platyserver.ddns.net"


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
        "--projects-dir",
        type=str,
        default="/storage6/dubbing_projects",
        help="Base directory containing all projects"
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development"
    )
    args = parser.parse_args()

    # Set environment variable for projects directory
    os.environ["SEGMENT_EDITOR_PROJECTS_DIR"] = args.projects_dir

    # Verify projects directory exists
    projects_dir = Path(args.projects_dir)
    if not projects_dir.exists():
        print(f"Error: Projects directory not found at {projects_dir}")
        sys.exit(1)

    # Count available projects
    projects = [d for d in projects_dir.iterdir()
                if d.is_dir() and (d / "transcriptions" / "segments.csv").exists()]

    print(f"Starting Segment Editor...")
    print(f"  Projects dir: {args.projects_dir}")
    print(f"  Available projects: {len(projects)}")
    print(f"  Port: {args.port}")
    print(f"")
    print(f"Open in your browser:")
    print(f"")
    print(f"  https://{NGINX_DOMAIN}/editor/")
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
