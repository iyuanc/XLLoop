#!/usr/bin/env python3
"""Run administrator-approved CI checks and produce a local preview report."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


MAX_JOB_BYTES = 100_000
MAX_OUTPUT_CHARS = 6_000
ALLOWED_TASKS = {"test", "preview"}


class PipelineError(Exception):
    pass


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def read_job() -> dict:
    raw = sys.stdin.buffer.read(MAX_JOB_BYTES + 1)
    if not raw or len(raw) > MAX_JOB_BYTES:
        raise PipelineError("执行任务为空或超过大小限制")
    job = json.loads(raw)
    if not isinstance(job, dict) or job.get("task") not in ALLOWED_TASKS:
        raise PipelineError("固定流水线不允许执行该任务")
    return job


def check_commands() -> dict[str, list[str]]:
    try:
        configured = json.loads(os.environ.get("XLLOOP_CHECK_COMMANDS_JSON", "{}"))
    except json.JSONDecodeError:
        raise PipelineError("XLLOOP_CHECK_COMMANDS_JSON 不是有效 JSON") from None
    if not isinstance(configured, dict):
        raise PipelineError("检查命令配置无效")
    result: dict[str, list[str]] = {}
    for name, command in configured.items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,50}", str(name)):
            raise PipelineError("检查命令名称无效")
        if (
            not isinstance(command, list)
            or not command
            or len(command) > 30
            or any(not isinstance(part, str) or not part for part in command)
        ):
            raise PipelineError(f"检查命令 {name} 必须是固定参数数组")
        result[str(name)] = command
    return result


def repositories(workspace: Path) -> list[dict]:
    raw = os.environ.get("XLLOOP_REPOSITORIES_JSON", "").strip()
    if not raw:
        names = [
            item.strip()
            for item in os.environ.get("XLLOOP_REQUIRED_TEST_CHECKS", "").split(",")
            if item.strip()
        ]
        return [{"id": ".", "path": workspace, "checks": names}]
    try:
        configured = json.loads(raw)
    except json.JSONDecodeError:
        raise PipelineError("执行器仓库配置不是有效 JSON") from None
    if not isinstance(configured, list) or not configured:
        raise PipelineError("执行器没有提供有效仓库")
    result: list[dict] = []
    for row in configured:
        if not isinstance(row, dict) or not re.fullmatch(
            r"[a-z0-9][a-z0-9_-]{0,49}", str(row.get("id") or "")
        ):
            raise PipelineError("执行器仓库标识无效")
        path = Path(str(row.get("path") or "")).resolve()
        try:
            path.relative_to(workspace)
        except ValueError:
            raise PipelineError("授权仓库超出隔离工作目录") from None
        if path.parent != workspace or not (path / ".git").exists():
            raise PipelineError(f"仓库 {row['id']} 的隔离目录无效")
        checks = row.get("checks")
        if not isinstance(checks, list) or any(not isinstance(x, str) for x in checks):
            raise PipelineError(f"仓库 {row['id']} 的检查配置无效")
        result.append({"id": row["id"], "path": path, "checks": list(dict.fromkeys(checks))})
    return result


def command_environment() -> dict[str, str]:
    allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_ENV"]
    result = {key: os.environ[key] for key in allowed if key in os.environ}
    result["CI"] = "1"
    return result


def run_check(repo: dict, name: str, commands: dict[str, list[str]]) -> dict:
    if name not in commands:
        raise PipelineError(f"仓库 {repo['id']} 引用了未配置的检查命令 {name}")
    try:
        timeout = int(os.environ.get("XLLOOP_CHECK_TIMEOUT_SECONDS", "300"))
    except ValueError:
        raise PipelineError("XLLOOP_CHECK_TIMEOUT_SECONDS 无效") from None
    timeout = min(1800, max(10, timeout))
    try:
        completed = subprocess.run(
            commands[name],
            cwd=repo["path"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
            env=command_environment(),
        )
        output = (completed.stdout or "")[-MAX_OUTPUT_CHARS:]
        return {"repository": repo["id"], "name": name, "passed": completed.returncode == 0, "output": output}
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or "") if isinstance(exc.stdout, str) else "")[-MAX_OUTPUT_CHARS:]
        return {"repository": repo["id"], "name": name, "passed": False, "output": output + "\n检查执行超时"}
    except FileNotFoundError as exc:
        return {"repository": repo["id"], "name": name, "passed": False, "output": f"命令不存在：{exc.filename}"}


def git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
        env=command_environment(),
    )
    if completed.returncode:
        raise PipelineError((completed.stderr or completed.stdout or "Git 命令失败")[-1000:])
    return completed.stdout.strip()


def main() -> None:
    try:
        job = read_job()
        task = job["task"]
        workspace = Path.cwd().resolve()
        commands = check_commands() if task == "test" else {}
        repos = repositories(workspace)
        results: list[dict] = []
        reports: list[str] = []
        previous = job.get("previous") if isinstance(job.get("previous"), list) else []
        previous_test = next(
            (item for item in previous if isinstance(item, dict) and item.get("task") == "test"),
            None,
        )
        if task == "preview" and not previous_test:
            raise PipelineError("缺少已完成的 CI 构建与业务流程测试证据")
        for repo in repos:
            if task == "test" and not repo["checks"]:
                raise PipelineError(f"仓库 {repo['id']} 未配置任何 CI 检查")
            branch = git(repo["path"], "branch", "--show-current")
            head = git(repo["path"], "rev-parse", "--short", "HEAD")
            status = git(repo["path"], "status", "--short")
            diff_stat = git(repo["path"], "diff", "--stat")
            if task == "test":
                for name in repo["checks"]:
                    result = run_check(repo, name, commands)
                    results.append(result)
                    if not result["passed"]:
                        emit(
                            {
                                "status": "failed",
                                "error": f"仓库 {repo['id']} 检查失败：{name}\n{result['output']}",
                                "cost": 0.0,
                            }
                        )
                        return
            reports.append(
                f"仓库 {repo['id']}；分支 {branch}；提交 {head}；"
                f"工作区 {'有待验收差异' if status else '干净'}。\n"
                f"差异摘要：\n{diff_stat or '无'}"
            )
        names = ", ".join(f"{row['repository']}:{row['name']}=PASS" for row in results)
        if task == "test":
            summary = "CI 构建与已配置业务流程检查通过。"
            mode = "ci"
        else:
            summary = "已根据上一环节 CI 结果生成代码差异与验收报告；尚未部署到公开预览地址。"
            mode = "acceptance-report"
        ci_evidence = "" if task == "test" else f"上一步 CI 证据：{str(previous_test.get('result', {}).get('evidence') or '')[:1500]}。\n"
        emit(
            {
                "status": "succeeded",
                "summary": summary,
                "evidence": ((f"固定检查：{names}。\n" if task == "test" else ci_evidence) + "\n\n".join(reports))[:6000],
                "cost": 0.0,
                "artifacts": [],
                "metrics": {"mode": mode, "checks": results},
            }
        )
    except Exception as exc:
        emit({"status": "failed", "error": str(exc)[:4000], "cost": 0.0})


if __name__ == "__main__":
    main()
