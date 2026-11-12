import json
import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parents[1]


with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    config_path = root / "runner-config.json"
    registry_path = root / "projects.json"
    env_path = root / "runner.env"
    config_path.write_text(
        json.dumps(
            {
                "provisioning": {"worktree_root": "/srv/xlloop/worktrees"},
                "projects": {
                    "ybirds": {
                        "cwd": "/srv/xlloop/worktrees/ybirds",
                        "env_allowlist": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
                        "tasks": {
                            "analysis": {
                                "command": ["python", "/opt/xlloop/adapters/openai_analysis.py"]
                            }
                        },
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    registry_path.write_text(
        json.dumps(
            {
                "project-one": {
                    "cwd": "/srv/xlloop/worktrees/project-one",
                    "env_allowlist": ["OPENAI_MODEL", "CLAUDE_MODEL"],
                    "tasks": {
                        "analysis": {
                            "command": ["python", "/opt/xlloop/adapters/openai_analysis.py"]
                        }
                    },
                    "repositories": [
                        {
                            "path": "/srv/xlloop/worktrees/project-one/web"
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    env_path.write_text(
        "XLLOOP_RUNNER_TOKEN=fixture\nOPENAI_API_KEY=must-be-removed\nANTHROPIC_API_KEY=keep-me\n",
        encoding="utf-8",
    )
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "configure-runner.py"),
            "--config",
            str(config_path),
            "--python",
            sys.executable,
            "--registry",
            str(registry_path),
            "--env-file",
            str(env_path),
        ],
        check=True,
    )
    config = json.loads(config_path.read_text(encoding="utf-8"))
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    assert config["provisioning"]["worktree_root"] == "/mnt/data500/xlloop/worktrees"
    assert config["projects"]["ybirds"]["cwd"] == "/mnt/data500/xlloop/worktrees/ybirds"
    assert registry["project-one"]["cwd"] == "/mnt/data500/xlloop/worktrees/project-one"
    assert registry["project-one"]["repositories"][0]["path"] == "/mnt/data500/xlloop/worktrees/project-one/web"
    assert "OPENAI_API_KEY" not in config["projects"]["ybirds"]["env_allowlist"]
    assert "analysis" not in config["projects"]["ybirds"]["tasks"]
    assert "OPENAI_MODEL" not in registry["project-one"]["env_allowlist"]
    assert "analysis" not in registry["project-one"]["tasks"]
    env_text = env_path.read_text(encoding="utf-8")
    assert "OPENAI_API_KEY" not in env_text
    assert "ANTHROPIC_API_KEY=keep-me" in env_text

print("PASS: storage paths migrate and legacy OpenAI configuration is removed")
