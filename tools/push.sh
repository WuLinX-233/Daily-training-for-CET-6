#!/usr/bin/env bash
# 用法：./push.sh <TOKEN> [仓库地址] [代理]
#   ./push.sh ghp_xxx
#   ./push.sh ghp_xxx https://github.com/<用户名>/<仓库名>.git http://127.0.0.1:7897
#
# TOKEN 可以是 fine-grained token（需 Contents: Read and write）或 classic token（需 repo 权限）。
# token 只在这一次命令里通过 -c url.*.insteadOf 临时注入，不会写进 .git/config。
set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN="${1:?第一个参数是 GitHub token}"
REPO="${2:-$(git remote get-url origin 2>/dev/null || true)}"
PROXY="${3:-http://127.0.0.1:7897}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

[ -n "$REPO" ] || { echo "没有 origin，也没有传仓库地址"; exit 1; }

# origin 指向不带 token 的干净地址
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$REPO"
elif [ "$(git remote get-url origin)" != "$REPO" ]; then
  git remote set-url origin "$REPO"
fi

echo "推送 $BRANCH → $REPO （代理 $PROXY）"

# insteadOf 只在这条命令生效：把 https://github.com/ 临时改写成带 token 的形式，
# 于是推的是「命名 remote origin」，refs/remotes/origin/$BRANCH 会跟着更新，
# 后面 git status 的 ahead/behind 才是准的（推裸 URL 不会更新跟踪分支）。
git -c http.proxy="$PROXY" -c https.proxy="$PROXY" \
    -c "url.https://${TOKEN}@github.com/.insteadOf=https://github.com/" \
    push origin "$BRANCH"

git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true

echo
git branch -vv | sed -n "/\* /p"
echo
echo "推送完成。Pages 约 30 秒后自动更新：https://<用户名>.github.io/<仓库名>/"
echo "线上验收：CHROME_PROXY=$PROXY node tools/check_live.js"
