#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="xlloop-web"
APP_USER="xlloop"
APP_HOME="/home/xlloop"
APP_ENV="/etc/xlloop/app.env"
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PM2_CONFIG="${APP_DIR}/deploy/ecosystem.config.cjs"

if [[ ${EUID} -ne 0 ]]; then
  echo "错误：请使用 root 执行：bash deploy.sh" >&2
  exit 1
fi

for command_name in git node pnpm pm2 runuser curl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "错误：缺少命令 ${command_name}" >&2
    exit 1
  fi
done

if ! id "${APP_USER}" >/dev/null 2>&1; then
  echo "错误：系统用户 ${APP_USER} 不存在" >&2
  exit 1
fi

if [[ ! -f "${APP_ENV}" ]] || ! runuser -u "${APP_USER}" -- test -r "${APP_ENV}"; then
  echo "错误：${APP_USER} 无法读取 ${APP_ENV}" >&2
  exit 1
fi

if [[ ! -f "${PM2_CONFIG}" ]]; then
  echo "错误：找不到 ${PM2_CONFIG}" >&2
  exit 1
fi

PNPM_BIN="$(command -v pnpm)"
PM2_BIN="$(command -v pm2)"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "错误：${APP_DIR} 不是 Git 仓库，无法更新 master 代码" >&2
  exit 1
fi

CURRENT_BRANCH="$(git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" branch --show-current)"
if [[ "${CURRENT_BRANCH}" != "master" ]]; then
  echo "错误：当前分支是 ${CURRENT_BRANCH:-未知}，请切换到 master 后再部署" >&2
  exit 1
fi

echo "[1/6] 拉取 master 最新代码"
git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" pull --ff-only origin master

echo "[2/6] 准备目录和权限"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 750 /var/log/xlloop
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

echo "[3/6] 安装依赖"
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PNPM_BIN}" --dir "${APP_DIR}" install --frozen-lockfile

echo "[4/6] 构建生产版本"
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PNPM_BIN}" --dir "${APP_DIR}" build

if [[ ! -f "${APP_DIR}/.next/standalone/server.js" ]]; then
  echo "错误：构建完成后未找到 .next/standalone/server.js" >&2
  exit 1
fi

echo "[5/6] 启动或重启 PM2"
runuser -u "${APP_USER}" -- env HOME="${APP_HOME}" \
  "${PM2_BIN}" startOrRestart "${PM2_CONFIG}" --update-env

echo "[6/6] 检查本机服务"
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
