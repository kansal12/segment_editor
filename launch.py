#!/usr/bin/env python3
"""
Segment Editor Launcher with Auto Port Assignment

Usage:
    python launch.py --project /path/to/project

Features:
    - Automatically assigns a port from a pool of 3 ports (8765, 8766, 8767)
    - Detects which ports are already in use
    - Prevents multiple instances for the same project
"""

import argparse
import os
import socket
import sys
import json
from pathlib import Path

# Port pool configuration
PORT_POOL = [8765, 8766, 8767]
LOCK_FILE = Path(__file__).parent / ".active_sessions.json"


def is_port_in_use(port: int) -> bool:
    """Check if a port is currently in use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('localhost', port)) == 0


def load_sessions() -> dict:
    """Load active sessions from lock file."""
    if LOCK_FILE.exists():
        try:
            with open(LOCK_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return {}
    return {}


def save_sessions(sessions: dict):
    """Save active sessions to lock file."""
    with open(LOCK_FILE, 'w') as f:
        json.dump(sessions, f, indent=2)


def cleanup_stale_sessions(sessions: dict) -> dict:
    """Remove sessions for ports that are no longer in use."""
    active = {}
    for port, project in sessions.items():
        if is_port_in_use(int(port)):
            active[port] = project
    return active


def find_available_port(sessions: dict) -> int:
    """Find the first available port from the pool."""
    used_ports = {int(p) for p in sessions.keys()}

    for port in PORT_POOL:
        if port not in used_ports and not is_port_in_use(port):
            return port

    return None


def get_project_port(sessions: dict, project_path: str) -> int:
    """Check if project is already running and return its port."""
    for port, project in sessions.items():
        if project == project_path:
            return int(port)
    return None


def main():
    parser = argparse.ArgumentParser(description="Segment Editor Launcher")
    parser.add_argument(
        "--project",
        type=str,
        required=True,
        help="Path to the dubbing project"
    )
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all active sessions"
    )
    args = parser.parse_args()

    # Load and cleanup sessions
    sessions = load_sessions()
    sessions = cleanup_stale_sessions(sessions)
    save_sessions(sessions)

    # List mode
    if args.list:
        if not sessions:
            print("No active sessions.")
        else:
            print("\nActive Sessions:")
            print("-" * 60)
            for port, project in sessions.items():
                project_name = Path(project).name
                print(f"  Port {port}: {project_name}")
                print(f"           {project}")
            print("-" * 60)
        return

    project_path = os.path.abspath(args.project)

    # Verify project exists
    segments_path = Path(project_path) / "transcriptions" / "segments.csv"
    chunks_path = Path(project_path) / "chunks"

    if not segments_path.exists():
        print(f"Error: segments.csv not found at {segments_path}")
        sys.exit(1)

    if not chunks_path.exists():
        print(f"Error: chunks directory not found at {chunks_path}")
        sys.exit(1)

    # Check if project is already running
    existing_port = get_project_port(sessions, project_path)
    if existing_port and is_port_in_use(existing_port):
        print(f"\nProject is already running!")
        print(f"  Project: {Path(project_path).name}")
        print(f"  URL: http://localhost:{existing_port}")
        print(f"\nOpen the URL above in your browser.")
        return

    # Find available port
    port = find_available_port(sessions)
    if port is None:
        print("\nError: All ports are in use!")
        print(f"Maximum {len(PORT_POOL)} concurrent sessions allowed.")
        print("\nActive sessions:")
        for p, proj in sessions.items():
            print(f"  Port {p}: {Path(proj).name}")
        sys.exit(1)

    # Register session
    sessions[str(port)] = project_path
    save_sessions(sessions)

    # Set environment and run
    os.environ["SEGMENT_EDITOR_PROJECT_PATH"] = project_path

    print(f"\nStarting Segment Editor...")
    print(f"  Project: {Path(project_path).name}")
    print(f"  Port: {port} (auto-assigned)")
    print(f"")
    print(f"Open in your browser:")
    print(f"")
    print(f"  http://localhost:{port}")
    print(f"")
    print(f"Press Ctrl+C to stop")
    print(f"")

    # Add backend to path and run
    backend_path = Path(__file__).parent / "backend"
    sys.path.insert(0, str(backend_path))

    import uvicorn
    try:
        uvicorn.run(
            "main:app",
            host=args.host,
            port=port,
            log_level="info",
        )
    finally:
        # Cleanup session on exit
        sessions = load_sessions()
        if str(port) in sessions:
            del sessions[str(port)]
            save_sessions(sessions)


if __name__ == "__main__":
    main()
