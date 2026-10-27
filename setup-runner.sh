#!/usr/bin/env bash
# One-time: creates your free GitHub cloud runner for phone auto-apply. Run from Cloud Shell:  bash ~/applyra/runner/setup-runner.sh
set -euo pipefail
cd "$(dirname "$0")"
B=$'\e[1m'; G=$'\e[32m'; N=$'\e[0m'
say() { echo -e "\n${B}▸ $*${N}"; }
PROJECT_ID=$(cat ../.applyra-project 2>/dev/null || gcloud config get-value project 2>/dev/null)
[ -n "$PROJECT_ID" ] || { echo "Run deploy.sh first"; exit 1; }
REPO=${REPO:-applyra-runner}

say "GitHub CLI"
if ! command -v gh >/dev/null; then
  V=2.62.0; mkdir -p ~/.local/bin
  curl -sSL "https://github.com/cli/cli/releases/download/v${V}/gh_${V}_linux_amd64.tar.gz" | tar xz -C /tmp
  cp /tmp/gh_${V}_linux_amd64/bin/gh ~/.local/bin/gh; export PATH="$HOME/.local/bin:$PATH"
fi
gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web --scopes "repo,workflow"
gh auth setup-git
OWNER=$(gh api user --jq .login)

say "Service account for the runner (free)"
gcloud services enable iam.googleapis.com --project "$PROJECT_ID" >/dev/null
SA="applyra-runner@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 || gcloud iam service-accounts create applyra-runner --display-name "Applyra cloud apply" --project "$PROJECT_ID"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role roles/datastore.user --condition=None >/dev/null
KEY=$(mktemp); trap 'rm -f "$KEY"' EXIT
gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" --project "$PROJECT_ID" >/dev/null

say "Pushing the runner to github.com/$OWNER/$REPO"
cp ../extension/filler.js ./filler.js
[ -d .git ] || git init -q -b main
git config user.email >/dev/null || git config user.email "applyra@users.noreply.github.com"
git config user.name >/dev/null || git config user.name "Applyra"
git add -A && (git commit -qm "Applyra cloud runner" || true)
if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"; git push -u origin main -q --force
else gh repo create "$OWNER/$REPO" --public --source . --push --description "Applyra cloud auto-apply runner"; fi
gh secret set FIREBASE_SA --repo "$OWNER/$REPO" < "$KEY"
gh variable set APP_URL --repo "$OWNER/$REPO" --body "https://${PROJECT_ID}.web.app"
gh workflow enable apply.yml --repo "$OWNER/$REPO" >/dev/null 2>&1 || true
gh workflow run apply.yml --repo "$OWNER/$REPO" || true
say "${G}Cloud runner ready${N} — it checks for queued applications every 20 minutes."
echo "  Watch runs: https://github.com/$OWNER/$REPO/actions"
