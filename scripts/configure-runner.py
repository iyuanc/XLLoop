#!/usr/bin/env python3
"""Safely add the bundled OpenAI analysis adapter to runner configuration."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


OPENAI_ENV = [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_INPUT_USD_PER_1M",
    "OPENAI_OUTPUT_USD_PER_1M",
    "OPENAI_CACHED_INPUT_USD_PER_1M",
    "OPENAI_TIMEOUT_SECONDS",
    "XLLOOP_ANALYTICS_FILE",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--adapter", required=True)
    args = parser.parse_args()

    path = Path(args.config)
    config = json.loads(path.read_text(encoding="utf-8"))
    projects = config.setdefault("projects", {})
    project = projects.setdefault("ybirds", {})
    current_cwd = str(project.get("cwd") or "")
    if not current_cwd or current_cwd.startswith("/absolute/path/"):
        project["cwd"] = "/srv/xlloop/worktrees/ybirds"
    for key in ("repo", "environment", "analytics", "cdn", "channels"):
        value = str(project.get(key) or "")
        if value.startswith("Fill the exact"):
            project[key] = ""
    allowlist = project.setdefault("env_allowlist", [])
    project["env_allowlist"] = list(dict.fromkeys([*allowlist, *OPENAI_ENV]))
    tasks = project.setdefault("tasks", {})
    analysis = tasks.setdefault("analysis", {})
    if not analysis.get("command"):
        analysis["command"] = [args.python, args.adapter]

    original = path.stat()
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(config, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.chmod(temporary, original.st_mode)
    if hasattr(os, "chown"):
        os.chown(temporary, original.st_uid, original.st_gid)
    os.replace(temporary, path)


if __name__ == "__main__":
    main()
