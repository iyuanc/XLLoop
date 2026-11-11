import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "executor" / "openai_analysis.py"
CONFIGURE = ROOT / "scripts" / "configure-runner.py"


def run_adapter(job, env):
    result = subprocess.run(
        [sys.executable, str(ADAPTER)],
        input=json.dumps(job),
        text=True,
        capture_output=True,
        env=env,
        check=True,
    )
    return json.loads(result.stdout)


job = {
    "task": "analysis",
    "command": "分析项目问题",
    "settings": {"analytics": ""},
    "budget": {"maxAdditionalCost": 10},
}

clean_env = {
    key: value
    for key, value in os.environ.items()
    if not key.startswith("OPENAI_") and key != "XLLOOP_ANALYTICS_FILE"
}
missing = run_adapter(job, clean_env)
assert missing == {"status": "failed", "error": "缺少业务数据", "cost": 0.0}

with tempfile.TemporaryDirectory() as directory:
    analytics = Path(directory) / "analytics.json"
    analytics.write_text('{"orders": 3}', encoding="utf-8")
    with_data = dict(clean_env, XLLOOP_ANALYTICS_FILE=str(analytics))
    configured_job = {**job, "settings": {"analytics": "test-fixture"}}
    no_key = run_adapter(configured_job, with_data)
    assert no_key == {"status": "failed", "error": "缺少 OPENAI_API_KEY", "cost": 0.0}

    config = Path(directory) / "runner-config.json"
    config.write_text(
        json.dumps(
            {
                "projects": {
                    "ybirds": {
                        "cwd": "/absolute/path/to/isolated/ybirds-worktree",
                        "analytics": "Fill the exact allowed data source",
                        "env_allowlist": [],
                        "tasks": {},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    subprocess.run(
        [
            sys.executable,
            str(CONFIGURE),
            "--config",
            str(config),
            "--python",
            "/usr/bin/python3.14",
            "--adapter",
            "/opt/xlloop/adapters/openai_analysis.py",
            "--claude-adapter",
            "/opt/xlloop/adapters/claude_code.py",
        ],
        check=True,
    )
    updated = json.loads(config.read_text(encoding="utf-8"))
    project = updated["projects"]["ybirds"]
    assert project["cwd"] == "/srv/xlloop/worktrees/ybirds"
    assert project["analytics"] == ""
    assert "OPENAI_API_KEY" in project["env_allowlist"]
    assert project["tasks"]["analysis"]["command"] == [
        "/usr/bin/python3.14",
        "/opt/xlloop/adapters/openai_analysis.py",
    ]
    assert "ANTHROPIC_API_KEY" in project["env_allowlist"]
    assert project["tasks"]["develop"]["command"] == [
        "/usr/bin/python3.14",
        "/opt/xlloop/adapters/claude_code.py",
    ]
    assert project["tasks"]["review"]["command"] == [
        "/usr/bin/python3.14",
        "/opt/xlloop/adapters/claude_code.py",
    ]

print("PASS: missing analytics fails without an OpenAI call; model adapters are configured safely")
