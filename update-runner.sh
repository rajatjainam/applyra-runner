#!/usr/bin/env bash
# Pushes the latest runner code + form filler to your GitHub runner (no new keys). Run:  bash ~/applyra/runner/update-runner.sh
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
[ -d .git ] || { echo "Runner not set up yet — run: bash ~/applyra/runner/setup-runner.sh"; exit 1; }
cp ../extension/filler.js ./filler.js
gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web --scopes "repo,workflow"
gh auth setup-git
git add -A && (git commit -qm "Update Applyra runner" || true)
git push -q origin main
REPO=$(git remote get-url origin | sed -E 's#.*github.com/##; s#\.git$##')
if ! gh secret list --repo "$REPO" 2>/dev/null | grep -q '^GEMINI_API_KEY'; then
  echo -e "\n\e[1m▸ AI form answers\e[0m — paste the same free Gemini key you put in Code.gs (input hidden), or press Enter to skip:"
  read -rs GK; echo
  [ -n "$GK" ] && printf '%s' "$GK" | gh secret set GEMINI_API_KEY --repo "$REPO" && echo "  ✔ Gemini key saved as a private GitHub secret"
fi
PROJECT_ID=$(cat ../.applyra-project 2>/dev/null || gcloud config get-value project 2>/dev/null)
FS="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/(default)/documents/private/github"
AT=$(gcloud auth print-access-token)
HAVE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AT" -H "x-goog-user-project: $PROJECT_ID" "$FS")
if [ "$HAVE" != "200" ] || [ "${NEW_TOKEN:-}" = "1" ]; then
  echo -e "\n\e[1m▸ Instant start (so jobs don't wait for GitHub's slow timer)\e[0m"
  echo "  1. Open: https://github.com/settings/personal-access-tokens/new"
  echo "  2. Name: Applyra runner · Expiration: 1 year · Repository access: Only select repositories → $REPO"
  echo "  3. Permissions → Repository → Actions: Read and write  (nothing else)"
  echo "  4. Generate token, copy it, paste below (input hidden). Press Enter to skip."
  read -rs GT; echo
  if [ -n "$GT" ]; then
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GT" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/actions/workflows")
    if [ "$CODE" = "200" ]; then
      curl -s -o /dev/null -X PATCH -H "Authorization: Bearer $AT" -H "x-goog-user-project: $PROJECT_ID" -H "Content-Type: application/json" \
        -d "{\"fields\":{\"token\":{\"stringValue\":\"$GT\"},\"repo\":{\"stringValue\":\"$REPO\"}}}" "$FS" && echo "  ✔ Instant start is on"
    else echo "  ✗ That token can't reach $REPO (GitHub said $CODE) — run again with:  NEW_TOKEN=1 bash ~/applyra/runner/update-runner.sh"; fi
  fi
fi
gh workflow run apply.yml --repo "$REPO" && echo -e "\n\e[32m✔ Runner updated and a run started.\e[0m Watch it: https://github.com/$REPO/actions"
