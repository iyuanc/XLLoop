import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "executor" / "fixed_pipeline.py"


def command(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def run_adapter(workspace, task, env):
    job = {
        "id": f"pipeline-{task}",
        "project": "fixture",
        "task": task,
        "command": "验证构建并生成验收证据",
        "budget": {"maxAdditionalCost": 1},
    }
    completed = subprocess.run(
        [sys.executable, str(ADAPTER)],
        cwd=workspace,
        input=json.dumps(job),
        text=True,
        capture_output=True,
        env=env,
        check=True,
    )
    assert completed.stderr == "", completed.stderr
    return json.loads(completed.stdout)


with tempfile.TemporaryDirectory() as directory:
    workspace = Path(directory)
    repo = workspace / "web"
    repo.mkdir()
    command("git", "init", "-b", "xlloop/fixture", cwd=repo)
    command("git", "config", "user.email", "fixture@example.test", cwd=repo)
    command("git", "config", "user.name", "Fixture", cwd=repo)
    (repo / "result.txt").write_text("ready\n", encoding="utf-8")
    command("git", "add", "result.txt", cwd=repo)
    command("git", "commit", "-m", "fixture", cwd=repo)
    (repo / "result.txt").write_text("changed\n", encoding="utf-8")

    env = dict(os.environ)
    env.update(
        {
            "XLLOOP_CHECK_COMMANDS_JSON": json.dumps(
                {
                    "build": [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; assert Path('result.txt').read_text() == 'changed\\n'",
                    ]
                }
            ),
            "XLLOOP_REPOSITORIES_JSON": json.dumps(
                [
                    {
                        "id": "web",
                        "path": str(repo),
                        "checks": ["build"],
                    }
                ]
            ),
        }
    )

    tested = run_adapter(workspace, "test", env)
    assert tested["status"] == "succeeded", tested
    assert tested["cost"] == 0
    assert tested["metrics"]["mode"] == "ci"
    assert tested["metrics"]["checks"][0]["passed"] is True

    previewed = run_adapter(workspace, "preview", env)
    assert previewed["status"] == "succeeded", previewed
    assert previewed["metrics"]["mode"] == "acceptance-report"
    assert previewed["artifacts"] == []
    assert "尚未部署到公开预览地址" in previewed["summary"]

    env["XLLOOP_CHECK_COMMANDS_JSON"] = json.dumps(
        {"build": [sys.executable, "-c", "print('fixture failure'); raise SystemExit(7)"]}
    )
    failed = run_adapter(workspace, "test", env)
    assert failed["status"] == "failed", failed
    assert failed["cost"] == 0
    assert "fixture failure" in failed["error"]

print("PASS: fixed CI and preview report adapter runs only authorized checks and returns verifiable output")
