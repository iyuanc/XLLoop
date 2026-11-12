import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "executor" / "claude_code.py"


class ClaudeFixture(BaseHTTPRequestHandler):
    calls = []
    develop_round = 0
    develop_path = "sample.py"
    count_available = True

    def log_message(self, *_args):
        pass

    def do_POST(self):
        size = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(size))
        self.__class__.calls.append((self.path, body, dict(self.headers)))
        if self.path == "/v1/messages/count_tokens":
            if not self.__class__.count_available:
                raw = json.dumps({"error": "count unavailable"}).encode()
                self.send_response(503)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            payload = {"input_tokens": 100}
        elif self.path == "/v1/messages" and body["model"] == "claude-analysis-fixture":
            payload = {
                "id": "msg_analysis_final",
                "content": [{"type": "text", "text": json.dumps({"verdict": "exists", "summary": "代码返回值与目标不一致。", "evidence": "sample.py 第2行返回 1。"}, ensure_ascii=False)}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 90, "output_tokens": 20},
            }
        elif self.path == "/v1/messages" and body["model"] == "claude-develop-fixture":
            self.__class__.develop_round += 1
            if self.__class__.develop_round == 1:
                payload = {
                    "id": "msg_develop_tool",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "tool_1",
                            "name": "replace_text",
                            "input": {
                                "path": self.__class__.develop_path,
                                "old_text": "return 1",
                                "new_text": "return 2",
                            },
                        }
                    ],
                    "stop_reason": "tool_use",
                    "usage": {"input_tokens": 100, "output_tokens": 20},
                }
            else:
                payload = {
                    "id": "msg_develop_final",
                    "content": [{"type": "text", "text": "已完成最小代码修改并保留待审查差异。"}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 120, "output_tokens": 30},
                }
        else:
            payload = {
                "id": "msg_review_final",
                "content": [{"type": "text", "text": "已完成只读审查。"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 80, "output_tokens": 10},
            }
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def command(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def adapter_env(port):
    env = dict(os.environ)
    env.update(
        {
            "ANTHROPIC_API_KEY": "fixture-key",
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{port}",
            "ANTHROPIC_VERSION": "fixture-version",
            "CLAUDE_INPUT_USD_PER_1M": "1",
            "CLAUDE_OUTPUT_USD_PER_1M": "2",
            "CLAUDE_CACHE_READ_USD_PER_1M": "0.1",
            "CLAUDE_CACHE_WRITE_USD_PER_1M": "1.25",
            "CLAUDE_DEVELOP_MODEL": "claude-develop-fixture",
            "CLAUDE_ANALYSIS_MODEL": "claude-analysis-fixture",
            "CLAUDE_REVIEW_MODEL": "claude-review-fixture",
            "CLAUDE_SPEC_MODEL": "claude-spec-fixture",
            "CLAUDE_MAX_OUTPUT_TOKENS": "256",
            "XLLOOP_BRANCH_PREFIX": "xlloop/",
            "XLLOOP_ALLOWED_BRANCHES": "xlloop/fixture",
            "XLLOOP_CHECK_COMMANDS_JSON": json.dumps(
                {
                    "tests": [
                        sys.executable,
                        "-c",
                        "from pathlib import Path; assert 'return 2' in Path('sample.py').read_text()",
                    ]
                }
            ),
            "XLLOOP_REQUIRED_DEVELOP_CHECKS": "tests",
            "XLLOOP_REQUIRED_REVIEW_CHECKS": "",
        }
    )
    return env


def run_adapter(repo, task, env):
    job = {
        "id": f"fixture-{task}",
        "project": "ybirds",
        "task": task,
        "command": "将 sample.py 的返回值改为 2" if task == "develop" else "审查当前修改",
        "scope": "preview",
        "settings": {"repo": "fixture"},
        "memory": [],
        "previous": [],
        "budget": {"maxAdditionalCost": 1},
    }
    result = subprocess.run(
        [sys.executable, str(ADAPTER)],
        cwd=repo,
        input=json.dumps(job),
        text=True,
        capture_output=True,
        env=env,
        check=True,
    )
    assert result.stderr == "", result.stderr
    return json.loads(result.stdout)


with tempfile.TemporaryDirectory() as directory:
    repo = Path(directory)
    command("git", "init", "-b", "xlloop/fixture", cwd=repo)
    command("git", "config", "user.email", "fixture@example.test", cwd=repo)
    command("git", "config", "user.name", "Fixture", cwd=repo)
    (repo / "sample.py").write_text("def value():\n    return 1\n", encoding="utf-8")
    command("git", "add", "sample.py", cwd=repo)
    command("git", "commit", "-m", "fixture", cwd=repo)

    server = ThreadingHTTPServer(("127.0.0.1", 0), ClaudeFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = adapter_env(server.server_port)
        ClaudeFixture.count_available = False
        specified = run_adapter(repo, "spec", env)
        assert specified["status"] == "succeeded", specified
        assert specified["metrics"]["token_count_fallbacks"] == 1
        assert specified["metrics"]["provider"] == "anthropic"
        ClaudeFixture.count_available = True
        diagnosed = run_adapter(repo, "analysis", env)
        assert diagnosed["status"] == "succeeded", diagnosed
        assert diagnosed["metrics"]["diagnosis"] == "exists"
        assert diagnosed["summary"].startswith("诊断结论：问题存在")
        developed = run_adapter(repo, "develop", env)
        assert developed["status"] == "succeeded", developed
        assert developed["metrics"]["provider"] == "anthropic"
        assert developed["metrics"]["model"] == "claude-develop-fixture"
        assert "return 2" in (repo / "sample.py").read_text(encoding="utf-8")
        assert "sample.py" in developed["evidence"]
        assert subprocess.run(
            ["git", "status", "--short"], cwd=repo, capture_output=True, text=True, check=True
        ).stdout.startswith(" M sample.py")
        assert subprocess.run(
            ["git", "rev-list", "--count", "HEAD"], cwd=repo, capture_output=True, text=True, check=True
        ).stdout.strip() == "1"

        before_review = (repo / "sample.py").read_bytes()
        reviewed = run_adapter(repo, "review", env)
        assert reviewed["status"] == "succeeded", reviewed
        assert reviewed["metrics"]["model"] == "claude-review-fixture"
        assert (repo / "sample.py").read_bytes() == before_review

        command("git", "restore", "sample.py", cwd=repo)
        command("git", "branch", "-m", "xlloop/not-authorized", cwd=repo)
        denied_branch = run_adapter(repo, "develop", env)
        assert denied_branch == {
            "status": "failed",
            "error": "当前隔离分支不在管理员授权列表中",
            "cost": 0.0,
        }
        command("git", "branch", "-m", "master", cwd=repo)
        denied = run_adapter(repo, "develop", env)
        assert denied == {
            "status": "failed",
            "error": "Claude 任务禁止在主分支、受保护分支或 detached HEAD 上运行",
            "cost": 0.0,
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

assert any(path == "/v1/messages/count_tokens" for path, _, _ in ClaudeFixture.calls)
assert any(path == "/v1/messages" for path, _, _ in ClaudeFixture.calls)
assert all(
    "max_tokens" not in body
    for path, body, _ in ClaudeFixture.calls
    if path == "/v1/messages/count_tokens"
)
assert all(
    {key.lower(): value for key, value in headers.items()}.get("anthropic-version")
    == "fixture-version"
    for _, _, headers in ClaudeFixture.calls
)

with tempfile.TemporaryDirectory() as directory:
    workspace = Path(directory)
    repositories = []
    for repo_id, access in (("web", "edit"), ("api", "read")):
        repo = workspace / repo_id
        repo.mkdir()
        command("git", "init", "-b", "xlloop/multi", cwd=repo)
        command("git", "config", "user.email", "fixture@example.test", cwd=repo)
        command("git", "config", "user.name", "Fixture", cwd=repo)
        (repo / "sample.py").write_text("def value():\n    return 1\n", encoding="utf-8")
        command("git", "add", "sample.py", cwd=repo)
        command("git", "commit", "-m", "fixture", cwd=repo)
        repositories.append(
            {
                "id": repo_id,
                "path": str(repo),
                "workBranch": "xlloop/multi",
                "access": access,
                "checks": ["tests"],
            }
        )

    ClaudeFixture.develop_round = 0
    ClaudeFixture.develop_path = "web/sample.py"
    server = ThreadingHTTPServer(("127.0.0.1", 0), ClaudeFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = adapter_env(server.server_port)
        env["XLLOOP_REPOSITORIES_JSON"] = json.dumps(repositories)
        developed = run_adapter(workspace, "develop", env)
        assert developed["status"] == "succeeded", developed
        assert developed["metrics"]["changed_files"] == ["web/sample.py"]
        assert developed["metrics"]["checks"][0]["repository"] == "web"
        assert "return 2" in (workspace / "web/sample.py").read_text(encoding="utf-8")
        assert "return 1" in (workspace / "api/sample.py").read_text(encoding="utf-8")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print("PASS: Claude task models, budgets, multi-repository isolation, branch controls, fixed checks, read-only repositories, and no automatic commit")
