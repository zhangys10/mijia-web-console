#!/usr/bin/env python3
"""Set up and run the local Console → Agent → Python fake-model integration stack."""

from __future__ import annotations

import argparse
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

CONSOLE_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = CONSOLE_ROOT.parent / "mijia-agent"
AGENT_ENV = CONSOLE_ROOT / ".local-integration.env"
CONSOLE_ENV = CONSOLE_ROOT / ".env.local"
EXPOSURE_DIR = CONSOLE_ROOT / ".local" / "assistant-exposure"

LOCAL_VALUES = {
    "NODE_ENV": "development",
    "AI_ENVIRONMENT": "development",
    "LOCAL_AGENT_PORT": "8789",
    "AI_AGENT_BASE_URL": "http://127.0.0.1:8789/",
    "MIJIA_CONSOLE_BASE_URL": "http://127.0.0.1:3000",
    "AI_PYTHON_BASE_URL": "http://127.0.0.1:8000",
    "AI_GATEWAY_BASE_URL": "http://127.0.0.1:9901/v1",
    "AI_GATEWAY_API_KEY": "local-fake-only",
    "AI_GATEWAY_MODEL": "local-integration-fixture",
    "AI_GATEWAY_ALLOWED_MODELS": "local-integration-fixture",
    "AI_QUOTA_ENABLED": "false",
}
SECRET_KEYS = (
    "AI_AGENT_INTERNAL_SECRET",
    "AI_PYTHON_INTERNAL_SECRET",
    "AI_TOOLS_INTERNAL_SECRET",
    "AI_AUTOMATION_TOKEN_SECRET",
    "AI_PRINCIPAL_SECRET",
    "XIAOMI_SESSION_SECRET",
)
CONSOLE_KEYS = (
    "AI_AGENT_BASE_URL",
    "AI_AGENT_INTERNAL_SECRET",
    "AI_TOOLS_INTERNAL_SECRET",
    "AI_AUTOMATION_TOKEN_SECRET",
    "AI_PRINCIPAL_SECRET",
    "XIAOMI_SESSION_SECRET",
    "AI_QUOTA_ENABLED",
    "AI_ASSISTANT_EXPOSURE_DIR",
    "AI_ENVIRONMENT",
)


def read_env(path: Path) -> dict[str, str]:
    values = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def write_private(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content)
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def new_config() -> dict[str, str]:
    return {
        **LOCAL_VALUES,
        **{key: secrets.token_urlsafe(36) for key in SECRET_KEYS},
        "AI_ASSISTANT_EXPOSURE_DIR": str(EXPOSURE_DIR),
    }


def update_console_env(values: dict[str, str]) -> None:
    current = CONSOLE_ENV.read_text().splitlines() if CONSOLE_ENV.exists() else []
    managed = set(CONSOLE_KEYS)
    kept = [
        line for line in current if not ("=" in line and line.split("=", 1)[0].strip() in managed)
    ]
    while kept and not kept[-1].strip():
        kept.pop()
    if kept:
        kept.append("")
    kept.append("# Managed by scripts/local-integration.py")
    kept.extend(f"{key}={values[key]}" for key in CONSOLE_KEYS)
    write_private(CONSOLE_ENV, "\n".join(kept) + "\n")


def setup(reset: bool) -> dict[str, str]:
    previous = {} if reset else read_env(AGENT_ENV)
    config = new_config()
    for key, value in LOCAL_VALUES.items():
        config[key] = value
    if not reset:
        for key in SECRET_KEYS:
            if previous.get(key, "") and len(previous[key]) >= 32:
                config[key] = previous[key]
    write_private(AGENT_ENV, "".join(f"{key}={value}\n" for key, value in config.items()))
    update_console_env(config)
    EXPOSURE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    EXPOSURE_DIR.chmod(0o700)
    return config


def wait_for_port(port: int, process: subprocess.Popen, name: str, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"{name} exited during startup (code {process.returncode})")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"{name} did not listen on 127.0.0.1:{port} within {timeout:g}s")


def start(config: dict[str, str]) -> int:
    python = AGENT_ROOT / ".venv" / "bin" / "python"
    uvicorn = AGENT_ROOT / ".venv" / "bin" / "uvicorn"
    node = shutil_which("node")
    npm = shutil_which("npm")
    missing = [str(path) for path in (python, uvicorn) if not path.exists()]
    if missing:
        raise RuntimeError("Missing agent Python environment: " + ", ".join(missing))
    if not node or not npm:
        raise RuntimeError("Node.js 22.13+ and npm must be available on PATH")
    if not (CONSOLE_ROOT / "node_modules").is_dir():
        raise RuntimeError(f"Console dependencies are missing; run npm ci in {CONSOLE_ROOT}")

    env = {**os.environ, **config}
    commands = [
        (
            "fake Gateway",
            [str(python), str(AGENT_ROOT / "scripts/fake-openai-gateway.py")],
            AGENT_ROOT,
            9901,
        ),
        (
            "Python Assistant",
            [
                str(uvicorn),
                "mijia_agent.app:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
                "--no-access-log",
            ],
            AGENT_ROOT,
            8000,
        ),
        (
            "Makers Agent shim",
            [node, "--experimental-strip-types", "scripts/local-agent-server.mjs"],
            AGENT_ROOT / "adapters/edgeone",
            8789,
        ),
        (
            "Web Console",
            [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", "3000"],
            CONSOLE_ROOT,
            3000,
        ),
    ]
    processes = []
    try:
        for name, command, cwd, port in commands:
            process = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
            processes.append((name, process))
            wait_for_port(port, process, name)
            print(f"ready: {name} at 127.0.0.1:{port}", flush=True)
        print("\nLocal stack is ready at http://127.0.0.1:3000", flush=True)
        print(
            "No model provider or EdgeOne Blob is used. Press Ctrl-C to stop all services.",
            flush=True,
        )
        while True:
            for name, process in processes:
                code = process.poll()
                if code is not None:
                    raise RuntimeError(f"{name} exited with code {code}")
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        for _name, process in reversed(processes):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for _name, process in reversed(processes):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()


def shutil_which(name: str) -> str | None:
    from shutil import which

    return which(name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "start"), nargs="?", default="start")
    parser.add_argument("--reset", action="store_true", help="regenerate local-only secrets")
    args = parser.parse_args()
    if args.reset and args.command != "setup":
        parser.error("--reset is only valid with setup")
    config = setup(args.reset)
    if args.command == "setup":
        print(f"Generated local-only environment in {AGENT_ENV} and {CONSOLE_ENV}")
        print("Secrets are stored with owner-only permissions; no Blob credentials are configured.")
        return 0
    try:
        return start(config)
    except RuntimeError as error:
        print(f"local integration startup failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
