#!/usr/bin/env bash
# Consistency checks for the public client packages. Runs in CI (packages.yml) and before every
# release; works in this repo and in the exported public repos (missing packages are skipped).
#
#   scripts/release/check.sh               names, URLs and versions agree with public.env
#   scripts/release/check.sh tag <tag>     also: <tag> (node-v1.2.3, python-v1.2.3, go-v1.2.3,
#                                          action-v1.2.3) matches that package's version
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck source=public.env
. scripts/release/public.env

fail=0
err() { echo "check: $*" >&2; fail=1; }
have() { [ -e "$1" ]; }
json() { node -e 'const p=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],p); process.stdout.write(String(v ?? ""))' "./$1" "$2"; }
toml_version() { sed -n 's/^version = "\(.*\)"$/\1/p' "$1" | head -1; }

SDK_URL="https://github.com/$PUBLIC_ORG/$SDK_REPO"
GO_MODULE="github.com/$PUBLIC_ORG/$GO_REPO"

# --- names and URLs -------------------------------------------------------------------------
if have packages/sdk-node/package.json; then
  [ "$(json packages/sdk-node/package.json name)" = "$NPM_SDK" ] || err "packages/sdk-node name is not $NPM_SDK"
  [ "$(json packages/sdk-node/package.json repository.url)" = "git+$SDK_URL.git" ] || err "packages/sdk-node repository.url is not git+$SDK_URL.git"
  [ "$(json packages/sdk-node/package.json bugs.url)" = "$SDK_URL/issues" ] || err "packages/sdk-node bugs.url is not $SDK_URL/issues"
fi
if have packages/cli/package.json; then
  [ "$(json packages/cli/package.json name)" = "$NPM_CLI" ] || err "packages/cli name is not $NPM_CLI"
  [ "$(json packages/cli/package.json repository.url)" = "git+$SDK_URL.git" ] || err "packages/cli repository.url is not git+$SDK_URL.git"
fi
if have packages/sdk-python/pyproject.toml; then
  grep -q "^name = \"$PYPI_NAME\"$" packages/sdk-python/pyproject.toml || err "pyproject name is not $PYPI_NAME"
  grep -q "^Repository = \"$SDK_URL\"$" packages/sdk-python/pyproject.toml || err "pyproject Repository is not $SDK_URL"
fi
for gomod in packages/sdk-go/go.mod go.mod; do
  if have "$gomod"; then
    [ "$(head -1 "$gomod")" = "module $GO_MODULE" ] || err "$gomod module is not $GO_MODULE"
  fi
done

# Every reference to a public repo or the action in tracked files must use public.env's values.
# Dated review snapshots under docs/review/ are historical records and keep the names they had.
files=$(git ls-files | grep -v -E '(^|/)package-lock\.json$|^scripts/release/|^docs/review/' || true)
if [ -n "$files" ]; then
  # shellcheck disable=SC2086
  stale=$(grep -n -o -E "github\.com/[A-Za-z0-9_.-]+/testlie-(sdk|go|action)|[A-Za-z0-9_.-]+/testlie-action@|testlie/testlie/action@" $files 2>/dev/null \
    | grep -v -E ":(github\.com/)?($PUBLIC_ORG/($SDK_REPO|$GO_REPO|$ACTION_REPO))(@|$)" || true)
  [ -z "$stale" ] || err "references that disagree with scripts/release/public.env (run scripts/release/set-org.sh):
$stale"
fi

# --- versions -------------------------------------------------------------------------------
node_v=""; py_v=""; go_v=""; action_v=""
if have packages/sdk-node/package.json; then
  node_v=$(json packages/sdk-node/package.json version)
  src_v=$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' packages/sdk-node/src/client.ts)
  [ "$src_v" = "$node_v" ] || err "packages/sdk-node/src/client.ts VERSION ($src_v) != package.json ($node_v)"
  if have packages/cli/package.json; then
    [ "$(json packages/cli/package.json version)" = "$node_v" ] || err "packages/cli version != $node_v"
    [ "$(json packages/cli/package.json "dependencies.$NPM_SDK")" = "$node_v" ] \
      || err "packages/cli must depend on $NPM_SDK at exactly $node_v"
  fi
fi
if have packages/sdk-python/pyproject.toml; then
  py_v=$(toml_version packages/sdk-python/pyproject.toml)
  init_v=$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' packages/sdk-python/src/testlie/client.py)
  [ "$init_v" = "$py_v" ] || err "testlie.__version__ ($init_v) != pyproject ($py_v)"
fi
for gofile in packages/sdk-go/testlie.go testlie.go; do
  if have "$gofile"; then go_v=$(sed -n 's/^const Version = "\(.*\)"$/\1/p' "$gofile"); fi
done
if have action/CHANGELOG.md; then
  action_v=$(sed -n 's/^## \[\([0-9][^]]*\)\].*/\1/p' action/CHANGELOG.md | head -1)
fi
# npm 11 drops a "bin" entry whose path starts with "./" when publishing (the command goes missing).
for pkg in packages/sdk-node/package.json packages/cli/package.json; do
  have "$pkg" || continue
  bad=$(node -e 'const b=require(process.argv[1]).bin||{}; console.log(Object.entries(b).filter(([,v])=>v.startsWith("./")).map(([k])=>k).join(" "))' "./$pkg")
  [ -z "$bad" ] || err "$pkg bin path starts with ./ ($bad); npm 11 removes it on publish"
done

changelog_has() { have "$1" || return 0; grep -q "^## \[$2\]" "$1" || err "$1 has no '## [$2]' section"; }
[ -z "$node_v" ] || { changelog_has packages/sdk-node/CHANGELOG.md "$node_v"; changelog_has packages/cli/CHANGELOG.md "$node_v"; }
[ -z "$py_v" ] || changelog_has packages/sdk-python/CHANGELOG.md "$py_v"
if [ -n "$go_v" ]; then changelog_has packages/sdk-go/CHANGELOG.md "$go_v"; changelog_has CHANGELOG.md "$go_v"; fi

# --- tag ------------------------------------------------------------------------------------
if [ "${1:-}" = "tag" ]; then
  tag="${2:?usage: check.sh tag <tag>}"
  case "$tag" in
    node-v*) want="$node_v" ;;
    python-v*) want="$py_v" ;;
    go-v*) want="$go_v" ;;
    action-v*) want="${tag#action-v}"; have action/CHANGELOG.md && changelog_has action/CHANGELOG.md "$want" ;;
    *) err "unknown tag $tag (expected node-v*, python-v*, go-v*, action-v*)"; want="" ;;
  esac
  got="${tag#*-v}"
  [ -z "$want" ] || [ "$got" = "$want" ] || err "tag $tag does not match the package version $want"
  echo "$got" | grep -q -E '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || err "tag $tag is not semver"
fi

if [ "$fail" = 0 ]; then
  echo "check: ok (org $PUBLIC_ORG; node ${node_v:--}, python ${py_v:--}, go ${go_v:--}, action ${action_v:--})"
fi
exit "$fail"
