#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="xlloop-web"
APP_USER="xlloop"
APP_HOME="/home/xlloop"
APP_ENV="/etc/xlloop/app.env"
RUNNER_ENV="/etc/xlloop/runner.env"
RUNNER_CONFIG="/etc/xlloop/runner-config.json"
RUNNER_DIR="/opt/xlloop/runner"
ADAPTER_DIR="/opt/xlloop/adapters"
DATA_ROOT="/mnt/data500/xlloop"
RUNTIME_DIR="${DATA_ROOT}/runtime"
WORKTREE_DIR="${DATA_ROOT}/worktrees"
ANALYTICS_DIR="${DATA_ROOT}/analytics"
LOG_DIR="${DATA_ROOT}/logs"
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PM2_CONFIG="${APP_DIR}/deploy/ecosystem.config.cjs"
RUNNER_WAS_ACTIVE=0

restore_runner_on_error() {
  if [[ ${RUNNER_WAS_ACTIVE} -eq 1 ]]; then
    systemctl start xlloop-runner.service >/dev/null 2>&1 || true
  fi
}

if [[ ${EUID} -ne 0 ]]; then
  echo "错误：请使用 root 执行：bash deploy.sh" >&2
  exit 1
fi

for command_name in git node pnpm pm2 runuser curl systemctl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "错误：缺少命令 ${command_name}" >&2
    exit 1
  fi
done

PYTHON_BIN="$(command -v python3.14 || command -v python3 || true)"
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "错误：缺少 Python 3.11 或更高版本" >&2
  exit 1
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  echo "错误：系统用户 ${APP_USER} 不存在" >&2
  exit 1
fi

if [[ ! -f "${APP_ENV}" ]] || ! runuser -u "${APP_USER}" -- test -r "${APP_ENV}"; then
  echo "错误：${APP_USER} 无法读取 ${APP_ENV}" >&2
  exit 1
fi

if [[ ! -f "${RUNNER_ENV}" ]] || ! runuser -u "${APP_USER}" -- test -r "${RUNNER_ENV}"; then
  echo "错误：${APP_USER} 无法读取 ${RUNNER_ENV}" >&2
  exit 1
fi

if [[ ! -f "${PM2_CONFIG}" ]]; then
  echo "错误：找不到 ${PM2_CONFIG}" >&2
  exit 1
fi

PNPM_BIN="$(command -v pnpm)"
PM2_BIN="$(command -v pm2)"
NODE_BIN="$(command -v node)"
RUNNER_PATH="$(dirname "${NODE_BIN}"):$(dirname "${PNPM_BIN}"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "错误：${APP_DIR} 不是 Git 仓库，无法更新 master 代码" >&2
  exit 1
fi

CURRENT_BRANCH="$(git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" branch --show-current)"
if [[ "${CURRENT_BRANCH}" != "master" ]]; then
  echo "错误：当前分支是 ${CURRENT_BRANCH:-未知}，请切换到 master 后再部署" >&2
  exit 1
fi

echo "[1/8] 拉取 master 最新代码"
git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" pull --ff-only origin master

echo "[2/8] 准备目录和权限"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 750 \
  "${DATA_ROOT}" "${RUNTIME_DIR}" "${WORKTREE_DIR}" \
  "${WORKTREE_DIR}/ybirds" "${LOG_DIR}"
install -d -o root -g "${APP_USER}" -m 750 "${ANALYTICS_DIR}"
install -d -o root -g "${APP_USER}" -m 750 "${RUNNER_DIR}" "${ADAPTER_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# One-time, recoverable migration from the former default paths. Stop the
# runner so its SQLite database is closed before copying. Old data is retained.
if systemctl is-active --quiet xlloop-runner.service; then
  RUNNER_WAS_ACTIVE=1
fi
trap restore_runner_on_error ERR
systemctl stop xlloop-runner.service 2>/dev/null || true
if [[ -f /var/lib/xlloop/jobs.sqlite && ! -e "${RUNTIME_DIR}/jobs.sqlite" ]]; then
  cp -a /var/lib/xlloop/jobs.sqlite "${RUNTIME_DIR}/jobs.sqlite"
fi
if [[ -f /var/lib/xlloop/projects.json && ! -e "${RUNTIME_DIR}/projects.json" ]]; then
  cp -a /var/lib/xlloop/projects.json "${RUNTIME_DIR}/projects.json"
fi
if [[ -d /srv/xlloop/worktrees ]] && \
   [[ -z "$(find "${WORKTREE_DIR}" -mindepth 1 -maxdepth 1 ! -name ybirds -print -quit)" ]] && \
   [[ -z "$(find "${WORKTREE_DIR}/ybirds" -mindepth 1 -print -quit)" ]]; then
  cp -a /srv/xlloop/worktrees/. "${WORKTREE_DIR}/"
fi
if [[ -d /srv/xlloop/analytics ]] && \
   [[ -z "$(find "${ANALYTICS_DIR}" -mindepth 1 -print -quit)" ]]; then
  cp -a /srv/xlloop/analytics/. "${ANALYTICS_DIR}/"
fi
chown -R "${APP_USER}:${APP_USER}" "${RUNTIME_DIR}" "${WORKTREE_DIR}" "${LOG_DIR}"
chown -R root:"${APP_USER}" "${ANALYTICS_DIR}"

echo "[3/8] 安装并配置执行器"
install -o root -g "${APP_USER}" -m 750 \
  "${APP_DIR}/executor/runner.py" "${RUNNER_DIR}/runner.py"
install -o root -g "${APP_USER}" -m 750 \
  "${APP_DIR}/executor/claude_code.py" "${ADAPTER_DIR}/claude_code.py"
rm -f "${ADAPTER_DIR}/openai_analysis.py"
if [[ ! -f "${RUNNER_CONFIG}" ]]; then
  install -o root -g "${APP_USER}" -m 640 \
    "${APP_DIR}/executor/config.example.json" "${RUNNER_CONFIG}"
fi
"${PYTHON_BIN}" "${APP_DIR}/scripts/configure-runner.py" \
  --config "${RUNNER_CONFIG}" \
  --python "${PYTHON_BIN}" \
  --claude-adapter "${ADAPTER_DIR}/claude_code.py" \
  --env-file "${RUNNER_ENV}" \
  --runtime-path "${RUNNER_PATH}" \
  --registry "${RUNTIME_DIR}/projects.json"
install -o root -g root -m 644 \
  "${APP_DIR}/deploy/systemd/xlloop-runner.service" \
  /etc/systemd/system/xlloop-runner.service
systemctl daemon-reload

echo "[4/8] 安装依赖"
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PNPM_BIN}" --dir "${APP_DIR}" install --frozen-lockfile

echo "[5/8] 构建生产版本"
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PNPM_BIN}" --dir "${APP_DIR}" build

if [[ ! -f "${APP_DIR}/.next/standalone/server.js" ]]; then
  echo "错误：构建完成后未找到 .next/standalone/server.js" >&2
  exit 1
fi

echo "[6/8] 启动或重启 PM2"
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PM2_BIN}" startOrRestart "${PM2_CONFIG}" --update-env

echo "[7/8] 启动或重启执行器"
systemctl enable --now xlloop-runner.service
systemctl restart xlloop-runner.service
if ! systemctl is-active --quiet xlloop-runner.service; then
  echo "错误：xlloop-runner.service 启动失败" >&2
  journalctl -u xlloop-runner.service -n 100 --no-pager || true
  exit 1
fi
RUNNER_WAS_ACTIVE=0
trap - ERR

echo "[8/8] 检查本机服务"
for attempt in {1..15}; do
  if curl --fail --silent --show-error --head \
    http://127.0.0.1:3100/login >/dev/null 2>&1; then
    runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
      "${PM2_BIN}" save
    echo "部署成功：${APP_NAME} 已监听 http://127.0.0.1:3100"
    exit 0
  fi
  sleep 1
done

echo "错误：${APP_NAME} 未能在 15 秒内通过健康检查" >&2
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PM2_BIN}" logs "${APP_NAME}" --lines 100 --nostream || true
exit 1
