#!/usr/bin/env bash
# 用法：./push.sh https://github.com/<用户名>/<仓库名>.git <TOKEN>
#
# TOKEN 可以是 fine-grained token（需 Contents: Read and write）或 classic token（需 repo 权限）。
# token 只在这一条命令里用一次，不会写进 .git/config。
set -euo pipefail

REPO="${1:?第一个参数是仓库地址，如 https://github.com/wulinx/cet6.git}"
TOKEN="${2:?第二个参数是 GitHub token}"
PROXY="${3:-http://127.0.0.1:7897}"

cd "$(dirname "$0")/.."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# 把 https://github.com/owner/repo.git 变成 https://<token>@github.com/owner/repo.git
PUSH_URL="$(printf '%s' "$REPO" | sed -E "s#^https://#https://${TOKEN}@#")"

git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"

echo "推送 $BRANCH → $REPO （走代理 $PROXY，首次约 84MB，慢一点）"
git -c http.proxy="$PROXY" -c https.proxy="$PROXY" push "$PUSH_URL" "$BRANCH"
git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true

echo
echo "推送完成。若还没开 Pages，去仓库 Settings → Pages 选 main / root 即可。"
echo "地址形如：https://<用户名>.github.io/<仓库名>/"
