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
gh workflow run apply.yml --repo "$REPO" && echo -e "\n\e[32m✔ Runner updated and a run started.\e[0m Watch it: https://github.com/$REPO/actions"
