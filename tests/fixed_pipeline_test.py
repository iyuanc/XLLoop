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


def run_adapter(workspace, task, env, previous=None):
    job = {
        "id": f"pipeline-{task}",
        "project": "fixture",
        "task": task,
        "command": "验证构建并生成验收证据",
        "budget": {"maxAdditionalCost": 1},
        "previous": previous or [],
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
                        "import os; from pathlib import Path; p=Path('.build-count'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1'); assert Path('result.txt').read_text() == 'changed\\n'; assert Path(os.environ['XDG_CONFIG_HOME']).parts[-2:] == ('runner-home', '.config')",
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
            "HOME": str(workspace / "runner-home"),
            "XDG_CONFIG_HOME": str(workspace / "runner-home" / ".config"),
            "XDG_DATA_HOME": str(workspace / "runner-home" / ".local" / "share"),
            "PNPM_HOME": str(workspace / "runner-home" / ".local" / "share" / "pnpm"),
        }
    )

    tested = run_adapter(workspace, "test", env)
    assert tested["status"] == "succeeded", tested
    assert tested["cost"] == 0
    assert tested["metrics"]["mode"] == "ci"
    assert tested["metrics"]["checks"][0]["passed"] is True
    assert (repo / ".build-count").read_text() == "1"

    previewed = run_adapter(workspace, "preview", env, [{"task": "test", "result": tested}])
    assert previewed["status"] == "succeeded", previewed
    assert previewed["metrics"]["mode"] == "acceptance-report"
    assert previewed["metrics"]["checks"] == []
    assert (repo / ".build-count").read_text() == "1"
    assert previewed["artifacts"] == []
    assert "尚未部署到公开预览地址" in previewed["summary"]

    env["XLLOOP_CHECK_COMMANDS_JSON"] = json.dumps(
        {"build": [sys.executable, "-c", "print('fixture failure'); raise SystemExit(7)"]}
    )
    failed = run_adapter(workspace, "test", env)
    assert failed["status"] == "failed", failed
    assert failed["cost"] == 0
    assert "fixture failure" in failed["error"]

print("PASS: fixed CI runs authorized checks once; preview reuses CI evidence without rebuilding")
