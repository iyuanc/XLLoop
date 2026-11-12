#!/usr/bin/env python3
"""Safely add the bundled model adapters to runner configuration."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from pathlib import Path

OLD_WORKTREE_ROOT = "/srv/xlloop/worktrees"
WORKTREE_ROOT = "/mnt/data500/xlloop/worktrees"

LEGACY_OPENAI_ENV = {
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_INPUT_USD_PER_1M",
    "OPENAI_OUTPUT_USD_PER_1M",
    "OPENAI_CACHED_INPUT_USD_PER_1M",
    "OPENAI_TIMEOUT_SECONDS",
}

CLAUDE_TASKS = ("spec", "develop", "review", "retro")
PIPELINE_TASKS = ("test", "preview")
CLAUDE_ENV = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_VERSION",
    "SSL_CERT_FILE",
    "CLAUDE_MODEL",
    "CLAUDE_INPUT_USD_PER_1M",
    "CLAUDE_OUTPUT_USD_PER_1M",
    "CLAUDE_CACHE_READ_USD_PER_1M",
    "CLAUDE_CACHE_WRITE_USD_PER_1M",
    "CLAUDE_MAX_OUTPUT_TOKENS",
    "CLAUDE_TIMEOUT_SECONDS",
    "CLAUDE_MAX_AGENT_STEPS",
    "XLLOOP_BRANCH_PREFIX",
    "XLLOOP_ALLOWED_BRANCHES",
    "XLLOOP_PROTECTED_BRANCHES",
    "XLLOOP_MAX_CHANGED_FILES",
    "XLLOOP_MAX_PATCH_BYTES",
    "XLLOOP_CHECK_COMMANDS_JSON",
    "XLLOOP_CHECK_TIMEOUT_SECONDS",
    "XLLOOP_REQUIRED_DEVELOP_CHECKS",
    "XLLOOP_REQUIRED_REVIEW_CHECKS",
    "XLLOOP_REQUIRED_TEST_CHECKS",
]
for task in CLAUDE_TASKS:
    prefix = f"CLAUDE_{task.upper()}"
    CLAUDE_ENV.extend(
        [
            f"{prefix}_MODEL",
            f"{prefix}_INPUT_USD_PER_1M",
            f"{prefix}_OUTPUT_USD_PER_1M",
            f"{prefix}_CACHE_READ_USD_PER_1M",
            f"{prefix}_CACHE_WRITE_USD_PER_1M",
            f"{prefix}_MAX_OUTPUT_TOKENS",
        ]
    )


def migrate_worktree_paths(projects: dict) -> None:
    for project in projects.values():
        if not isinstance(project, dict):
            continue
        cwd = str(project.get("cwd") or "")
        if cwd == OLD_WORKTREE_ROOT or cwd.startswith(OLD_WORKTREE_ROOT + "/"):
            project["cwd"] = WORKTREE_ROOT + cwd[len(OLD_WORKTREE_ROOT) :]
        for repository in project.get("repositories", []):
            if not isinstance(repository, dict):
                continue
            path = str(repository.get("path") or "")
            if path == OLD_WORKTREE_ROOT or path.startswith(OLD_WORKTREE_ROOT + "/"):
                repository["path"] = WORKTREE_ROOT + path[len(OLD_WORKTREE_ROOT) :]


def remove_legacy_openai(projects: dict) -> None:
    for project in projects.values():
        if not isinstance(project, dict):
            continue
        allowlist = project.get("env_allowlist", [])
        if isinstance(allowlist, list):
            project["env_allowlist"] = [
                value for value in allowlist if value not in LEGACY_OPENAI_ENV
            ]
        tasks = project.get("tasks")
        if not isinstance(tasks, dict):
            continue
        analysis = tasks.get("analysis")
        command = analysis.get("command", []) if isinstance(analysis, dict) else []
        if isinstance(command, list) and any(
            "openai_analysis.py" in str(value) for value in command
        ):
            tasks.pop("analysis", None)


def update_env_file(path: Path, runtime_path: str | None = None) -> None:
    if not path.is_file():
        return
    original = path.stat()
    pattern = re.compile(r"^\s*(?:export\s+)?OPENAI_[A-Z0-9_]+\s*=")
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not pattern.match(line)]
    if not any(re.match(r"^\s*(?:export\s+)?SSL_CERT_FILE\s*=", line) for line in lines):
        lines.append("SSL_CERT_FILE=/etc/pki/tls/certs/ca-bundle.crt")
    if runtime_path:
        lines = [line for line in lines if not re.match(r"^\s*(?:export\s+)?PATH\s*=", line)]
        lines.append(f"PATH={runtime_path}")
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        handle.write("\n".join(lines).rstrip() + "\n")
        temporary = Path(handle.name)
    os.chmod(temporary, original.st_mode)
    if hasattr(os, "chown"):
        os.chown(temporary, original.st_uid, original.st_gid)
    os.replace(temporary, path)


def atomic_json(path: Path, data: dict) -> None:
    original = path.stat()
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    os.chmod(temporary, original.st_mode)
    if hasattr(os, "chown"):
        os.chown(temporary, original.st_uid, original.st_gid)
    os.replace(temporary, path)


def configure_claude(projects: dict, python: str, adapter: str | None) -> None:
    if not adapter:
        return
    for project in projects.values():
        if not isinstance(project, dict):
            continue
        allowlist = project.setdefault("env_allowlist", [])
        if not isinstance(allowlist, list):
            allowlist = []
        project["env_allowlist"] = list(dict.fromkeys([*allowlist, *CLAUDE_ENV]))
        tasks = project.setdefault("tasks", {})
        if not isinstance(tasks, dict):
            tasks = {}
            project["tasks"] = tasks
        for task in CLAUDE_TASKS:
            task_config = tasks.setdefault(task, {})
            if isinstance(task_config, dict) and not task_config.get("command"):
                task_config["command"] = [python, adapter]


def configure_pipeline(projects: dict, python: str, adapter: str | None) -> None:
    if not adapter:
        return
    for project in projects.values():
        if not isinstance(project, dict):
            continue
        tasks = project.setdefault("tasks", {})
        if not isinstance(tasks, dict):
            tasks = {}
            project["tasks"] = tasks
        for task in PIPELINE_TASKS:
            task_config = tasks.setdefault(task, {})
            if isinstance(task_config, dict) and not task_config.get("command"):
                task_config["command"] = [python, adapter]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--claude-adapter")
    parser.add_argument("--pipeline-adapter")
    parser.add_argument("--env-file")
    parser.add_argument("--runtime-path")
    parser.add_argument("--registry")
    args = parser.parse_args()

    path = Path(args.config)
    config = json.loads(path.read_text(encoding="utf-8"))
    provisioning = config.setdefault("provisioning", {})
    provisioning.setdefault("enabled", True)
    if provisioning.get("worktree_root") in (None, "", OLD_WORKTREE_ROOT):
        provisioning["worktree_root"] = WORKTREE_ROOT
    provisioning.setdefault("allowed_git_hosts", ["gitlab.ybirds.cn"])
    provisioning.setdefault("publish_enabled", True)
    provisioning.setdefault("commit_name", "XLLoop Automation")
    provisioning.setdefault("commit_email", "xlloop@localhost")
    provisioning.setdefault("template_project", "ybirds")
    projects = config.setdefault("projects", {})
    project = projects.setdefault("ybirds", {})
    current_cwd = str(project.get("cwd") or "")
    if not current_cwd or current_cwd.startswith("/absolute/path/"):
        project["cwd"] = WORKTREE_ROOT + "/ybirds"
    migrate_worktree_paths(projects)
    remove_legacy_openai(projects)
    for key in ("repo", "environment", "analytics", "cdn", "channels"):
        value = str(project.get(key) or "")
        if value.startswith("Fill the exact"):
            project[key] = ""
    configure_claude(projects, args.python, args.claude_adapter)
    configure_pipeline(projects, args.python, args.pipeline_adapter)

    atomic_json(path, config)
    if args.registry:
        registry_path = Path(args.registry)
        if registry_path.is_file():
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
            if not isinstance(registry, dict):
                raise ValueError("Dynamic project registry must be a JSON object")
            migrate_worktree_paths(registry)
            remove_legacy_openai(registry)
            configure_claude(registry, args.python, args.claude_adapter)
            configure_pipeline(registry, args.python, args.pipeline_adapter)
            atomic_json(registry_path, registry)
    if args.env_file:
        update_env_file(Path(args.env_file), args.runtime_path)


if __name__ == "__main__":
    main()
