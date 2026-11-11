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
    config_path.write_text(
        json.dumps(
            {
                "provisioning": {"worktree_root": "/srv/xlloop/worktrees"},
                "projects": {
                    "ybirds": {
                        "cwd": "/srv/xlloop/worktrees/ybirds",
                        "tasks": {},
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
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "configure-runner.py"),
            "--config",
            str(config_path),
            "--python",
            sys.executable,
            "--adapter",
            str(ROOT / "executor" / "openai_analysis.py"),
            "--registry",
            str(registry_path),
        ],
        check=True,
    )
    config = json.loads(config_path.read_text(encoding="utf-8"))
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    assert config["provisioning"]["worktree_root"] == "/mnt/data500/xlloop/worktrees"
    assert config["projects"]["ybirds"]["cwd"] == "/mnt/data500/xlloop/worktrees/ybirds"
    assert registry["project-one"]["cwd"] == "/mnt/data500/xlloop/worktrees/project-one"
    assert registry["project-one"]["repositories"][0]["path"] == "/mnt/data500/xlloop/worktrees/project-one/web"

print("PASS: runner configuration and dynamic registry migrate legacy storage paths")
