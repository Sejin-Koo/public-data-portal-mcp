#!/usr/bin/env bash
# 데이터 파일을 릴리스 첨부파일로 올리고 가리킴 파일(data-release.json)만 main에 커밋한다.
#   scripts/commit-data-release.sh "<커밋 메시지>" [prune:<접두>] <파일...>
# 다른 워크플로가 먼저 가리킴을 고쳤으면 최신 가리킴 위에서 다시 올리고 다시 커밋한다(최대 5회).
set -euo pipefail
if [ -n "${GITHUB_REF_NAME:-}" ] && [ "$GITHUB_REF_NAME" != "main" ]; then
  echo "main이 아닌 브랜치($GITHUB_REF_NAME) 실행 — 릴리스·가리킴을 고치지 않는다"; exit 0
fi
MSG="$1"; shift
PRUNE=""
if [[ "${1:-}" == prune:* ]]; then PRUNE="${1#prune:}"; shift; fi
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
for i in 1 2 3 4 5; do
  git fetch -q origin main
  git reset -q --hard origin/main
  node scripts/release-data.mjs publish "$@"
  if [ -n "$PRUNE" ]; then node scripts/release-data.mjs prune "$PRUNE"; fi
  git add data-release.json
  if git diff --cached --quiet; then echo "변경 없음 — 커밋 생략"; exit 0; fi
  git commit -q -m "$MSG"
  if git push -q origin HEAD:main; then echo "가리킴 커밋 완료"; exit 0; fi
  echo "push 거절 — 최신 main 위에서 다시 시도 ($i)"; sleep $((i * 3))
done
echo "::error::가리킴 커밋 실패"; exit 1
