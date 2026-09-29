#!/usr/bin/env bash
# Read-only prerequisite check for running java-lsp/spring-lsp on Windows. Run it in Git Bash on the
# machine that will run the servers; it changes nothing.
#
# Usage: scripts/windows-preflight.sh [path/to/jdk21/bin/java.exe]
#
# The optional argument is the java you will put in the config as
# KEALTHAS_JAVA_LSP_JDTLS_LAUNCHER_JAVA_EXECUTABLE / KEALTHAS_SPRING_LSP_LAUNCHER_JAVA_EXECUTABLE.
# Give it whenever the java on PATH (or JAVA_HOME) is older than 21.
set -u
FAILS=0
ok() { echo "  OK    $*"; }
bad() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }
note() { echo "  NOTE  $*"; }

java_major() {
  # "1.8.0_502" -> 8, "21.0.11" -> 21
  local v
  v=$("$1" -version 2>&1 | grep -m1 ' version "' | sed -E 's/.* version "([^"]+)".*/\1/')
  case "$v" in 1.*) echo "$v" | cut -d. -f2 ;; *) echo "$v" | cut -d. -f1 ;; esac
}

echo "== shell"
case "$(uname -s)" in
  MINGW*|MSYS*) ok "Git Bash ($(uname -s))" ;;
  *) bad "not Git Bash (uname: $(uname -s)) - run this from Git Bash; mkdir/tar must come from it" ;;
esac
for c in mkdir tar; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c at $(command -v $c)"; else bad "$c not on PATH"; fi
done

echo "== Python 3 (java-lsp only; spring-lsp does not need it)"
PY=""
for cand in "python3" "python" "py -3"; do
  # shellcheck disable=SC2086
  if out=$($cand --version 2>&1) && echo "$out" | grep -q '^Python 3\.'; then PY="$cand"; ok "'$cand' -> $out"; break; fi
done
[ -z "$PY" ] && bad "none of 'python3', 'python', 'py -3' runs Python 3 (the Microsoft Store python3 stub does not count)"

echo "== Node"
if command -v node >/dev/null 2>&1; then ok "node $(node -v)"; else bad "node not on PATH"; fi

echo "== java that launches jdtls / spring-boot-language-server (must be 21+)"
PATH_JAVA=$(command -v java || true)
if [ -n "$PATH_JAVA" ]; then
  m=$(java_major "$PATH_JAVA")
  if [ "${m:-0}" -ge 21 ] 2>/dev/null; then ok "java on PATH is $m ($PATH_JAVA) - no launcher key needed"; else note "java on PATH is $m ($PATH_JAVA), below 21 - the launcher keys below are REQUIRED"; fi
else
  note "no java on PATH - the launcher keys below are REQUIRED"
fi
if [ -n "${JAVA_HOME:-}" ]; then
  if [ -x "$JAVA_HOME/bin/java.exe" ] || [ -x "$JAVA_HOME/bin/java" ]; then
    jm=$(java_major "$JAVA_HOME/bin/java")
    note "JAVA_HOME=$JAVA_HOME is java $jm (used by jdtls when no launcher key is set; below 21 makes jdtls exit)"
  else
    note "JAVA_HOME=$JAVA_HOME has no bin/java"
  fi
fi
if [ $# -ge 1 ]; then
  if [ -x "$1" ] || [ -f "$1" ]; then
    m=$("$1" -version >/dev/null 2>&1 && java_major "$1")
    if [ "${m:-0}" -ge 21 ] 2>/dev/null; then ok "the java you passed is $m ($1) - use this path in the launcher keys (forward slashes in JSON)"; else bad "the java you passed is not 21+ (got '${m:-unrunnable}'): $1"; fi
  else
    bad "not a file: $1"
  fi
elif [ -z "$PATH_JAVA" ] || [ "$(java_major "$PATH_JAVA")" -lt 21 ] 2>/dev/null; then
  bad "java 21+ is needed but none is reachable - rerun with the path to a JDK 21 java.exe as the argument"
fi

echo "== paths"
here=$(pwd)
if [ ${#here} -gt 120 ]; then note "current directory path is ${#here} chars; installs nested under node_modules can hit Windows' 260-char path limit"; else ok "current directory path length ${#here}"; fi
case "$HOME" in *" "*) note "HOME contains a space: $HOME" ;; esac

echo
if [ "$FAILS" -eq 0 ]; then echo "PREFLIGHT PASSED"; else echo "PREFLIGHT FAILED ($FAILS problem(s))"; exit 1; fi
