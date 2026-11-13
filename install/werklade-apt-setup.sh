#!/usr/bin/env bash
# werklade-apt-setup.sh - add or remove the Werklade APT repository.
# Target: Debian 13 / Ubuntu 24.04+ (amd64), Bash 5.
# Does exactly what README.md (section "APT repository") describes for the manual procedure.
set -euo pipefail

readonly BASE_URL="https://pkg.werklade.de"
readonly KEY_URL="${BASE_URL}/werklade-archive-keyring.asc"
readonly EXPECTED_FPR="498EF081BBC750A111DB2EDAE0CDAE7D9332A76C"
readonly KEY_DIR="/etc/apt/keyrings"
readonly KEY_FILE="${KEY_DIR}/werklade-archive-keyring.asc"
readonly SOURCES_DIR="/etc/apt/sources.list.d"
readonly SOURCES_FILE="${SOURCES_DIR}/werklade.sources"
readonly MIN_GLIBC="2.39"
# Same content as the manual procedure in README.md.
readonly SOURCES_CONTENT="Types: deb
URIs: https://pkg.werklade.de/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: ${KEY_FILE}
"

DRY_RUN=0
MODE="setup"
PACKAGES=()
WORKDIR=""
TMP_SOURCES=""

log() { printf '%s\n' "$*"; }
warn() { printf 'Warnung: %s\n' "$*" >&2; }
die() {
  printf 'Fehler: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Aufruf: werklade-apt-setup.sh [Optionen]

Bindet das Werklade-APT-Repository (pkg.werklade.de) ein.

Optionen:
  (keine)               Quelle und Schlüssel einrichten, dann apt-get update
  --install <Paket>...  einrichten, dann die Pakete installieren (z. B. werkterm)
  --remove              Quelle und Schlüssel entfernen (Pakete bleiben installiert)
  --dry-run             Aktionen nur anzeigen, nichts ändern (ohne root möglich)
  -h, --help            diese Hilfe

Exit-Codes: 0 Erfolg, 1 Fehler, 2 falsche Verwendung.
EOF
}

usage_error() {
  printf 'Fehler: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

cleanup() {
  if [[ -n "$TMP_SOURCES" ]]; then
    rm -f -- "$TMP_SOURCES"
  fi
  if [[ -n "$WORKDIR" && -d "$WORKDIR" ]]; then
    rm -rf -- "$WORKDIR"
  fi
}
trap cleanup EXIT

# Run a command, or only print it in dry-run mode.
run() {
  if ((DRY_RUN)); then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

parse_args() {
  while (($#)); do
    case "$1" in
      -h | --help)
        usage
        exit 0
        ;;
      --dry-run) DRY_RUN=1 ;;
      --remove)
        [[ "$MODE" == "install" ]] && usage_error "--remove und --install schließen sich aus"
        MODE="remove"
        ;;
      --install)
        [[ "$MODE" == "remove" ]] && usage_error "--remove und --install schließen sich aus"
        MODE="install"
        shift
        while (($#)) && [[ "$1" != -* ]]; do
          [[ "$1" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || usage_error "ungültiger Paketname: $1"
          PACKAGES+=("$1")
          shift
        done
        ((${#PACKAGES[@]})) || usage_error "--install braucht mindestens ein Paket"
        continue
        ;;
      *) usage_error "unbekannte Option: $1" ;;
    esac
    shift
  done
}

ensure_root() {
  ((DRY_RUN)) && return 0
  ((EUID == 0)) && return 0
  if command -v sudo >/dev/null 2>&1 && [[ -f "$0" ]]; then
    log "Root-Rechte nötig, starte neu mit sudo."
    exec sudo -- "$BASH" "$0" "${ORIG_ARGS[@]}"
  fi
  die "Root-Rechte nötig (sudo nicht gefunden oder Skript nicht als Datei gestartet)."
}

check_system() {
  [[ -r /etc/os-release ]] || die "/etc/os-release nicht lesbar."
  local ids
  ids="$(
    # shellcheck disable=SC1091
    . /etc/os-release
    printf '%s %s' "${ID:-}" "${ID_LIKE:-}"
  )"
  case " $ids " in
    *" debian "* | *" ubuntu "*) ;;
    *) die "Nur Debian und Ubuntu werden unterstützt (gefunden: ${ids})." ;;
  esac

  command -v dpkg >/dev/null 2>&1 || die "dpkg nicht gefunden."
  local arch
  arch="$(dpkg --print-architecture)"
  [[ "$arch" == "amd64" ]] || die "Nur amd64 wird unterstützt (gefunden: ${arch})."

  command -v apt-get >/dev/null 2>&1 || die "apt-get nicht gefunden."
  log "System geprüft: ${ids% }, ${arch}."
}

check_glibc() {
  local ver=""
  if command -v getconf >/dev/null 2>&1; then
    ver="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)"
  fi
  if [[ -z "$ver" ]] && command -v ldd >/dev/null 2>&1; then
    ver="$(ldd --version 2>&1 | awk 'NR==1 {print $NF}' || true)"
  fi
  if [[ ! "$ver" =~ ^[0-9]+\.[0-9]+ ]]; then
    warn "glibc-Version nicht ermittelbar; Werkterm braucht glibc ${MIN_GLIBC} oder neuer."
    return 0
  fi
  local lowest
  lowest="$(printf '%s\n%s\n' "$MIN_GLIBC" "$ver" | sort -V | head -n 1)"
  if [[ "$lowest" != "$MIN_GLIBC" ]]; then
    warn "glibc ${ver} ist älter als ${MIN_GLIBC}: werkterm lässt sich hier nicht installieren."
  fi
}

ensure_tools() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v gpg >/dev/null 2>&1 || missing+=(gpg)
  ((${#missing[@]})) || return 0
  log "Fehlende Werkzeuge: ${missing[*]}. Installiere sie mit apt-get."
  # Fresh systems may have empty package lists.
  run apt-get update
  run apt-get install -y "${missing[@]}"
}

# Print the primary key fingerprints (one per pub record) of an armored key file.
primary_fingerprints() {
  local file="$1" gnupghome="$2"
  gpg --homedir "$gnupghome" --batch --no-tty --with-colons --show-keys "$file" |
    awk -F: '
      $1 == "pub" { want = 1; next }
      $1 == "fpr" && want { print $10; want = 0 }
    '
}

# Install a file with the given mode unless identical content is already there.
install_if_changed() {
  local mode="$1" src="$2" dst="$3" label="$4"
  if [[ -f "$dst" ]] && cmp -s -- "$src" "$dst"; then
    chmod "$mode" -- "$dst"
    log "${label}: unverändert."
  else
    install -m "$mode" -- "$src" "$dst"
    log "${label}: installiert (${dst})."
  fi
}

setup_key() {
  if ((DRY_RUN)); then
    log "[dry-run] curl -fsSL --proto '=https' --tlsv1.2 ${KEY_URL} (in temporäres Verzeichnis)"
    log "[dry-run] Fingerprint mit gpg prüfen, erwartet: ${EXPECTED_FPR}"
    log "[dry-run] install -d -m 0755 ${KEY_DIR}"
    log "[dry-run] install -m 0644 <Schlüssel> ${KEY_FILE}"
    return 0
  fi

  WORKDIR="$(mktemp -d)"
  local keyfile="${WORKDIR}/werklade-archive-keyring.asc"
  local gnupghome="${WORKDIR}/gnupg"
  mkdir -m 0700 -- "$gnupghome"

  log "Lade Schlüssel von ${KEY_URL}."
  curl -fsSL --proto '=https' --tlsv1.2 -o "$keyfile" "$KEY_URL" ||
    die "Schlüssel-Download fehlgeschlagen."

  local fprs
  fprs="$(primary_fingerprints "$keyfile" "$gnupghome")" ||
    die "Schlüsseldatei nicht lesbar."
  local count=0
  [[ -n "$fprs" ]] && count="$(printf '%s\n' "$fprs" | wc -l)"
  ((count == 1)) || die "Erwartet genau einen Hauptschlüssel, gefunden: ${count}. Abbruch ohne Änderung."
  [[ "$fprs" == "$EXPECTED_FPR" ]] ||
    die "Fingerprint stimmt nicht überein (gefunden: ${fprs}). Abbruch ohne Änderung."
  log "Fingerprint geprüft: ${EXPECTED_FPR}."

  install -d -m 0755 -- "$KEY_DIR"
  install_if_changed 0644 "$keyfile" "$KEY_FILE" "Schlüssel"
}

setup_sources() {
  if ((DRY_RUN)); then
    log "[dry-run] ${SOURCES_FILE} atomar schreiben (Modus 0644), Inhalt:"
    printf '%s' "$SOURCES_CONTENT" | sed 's/^/[dry-run]   /'
    return 0
  fi

  install -d -m 0755 -- "$SOURCES_DIR"
  # Same directory so mv is an atomic rename; no .sources suffix so apt ignores it.
  TMP_SOURCES="$(mktemp "${SOURCES_DIR}/.werklade.sources.XXXXXX")"
  printf '%s' "$SOURCES_CONTENT" >"$TMP_SOURCES"
  chmod 0644 -- "$TMP_SOURCES"
  if [[ -f "$SOURCES_FILE" ]] && cmp -s -- "$TMP_SOURCES" "$SOURCES_FILE"; then
    chmod 0644 -- "$SOURCES_FILE"
    log "Quelle: unverändert."
  else
    mv -f -- "$TMP_SOURCES" "$SOURCES_FILE"
    log "Quelle: geschrieben (${SOURCES_FILE})."
  fi
  rm -f -- "$TMP_SOURCES"
  TMP_SOURCES=""
}

warn_other_references() {
  [[ -e "${SOURCES_DIR}/werklade.list" ]] &&
    warn "${SOURCES_DIR}/werklade.list existiert (altes Format). Manuell entfernen, sonst doppelte Einträge."
  local hits=()
  local f
  if [[ -d "$SOURCES_DIR" || -f /etc/apt/sources.list ]]; then
    while IFS= read -r f; do
      [[ "$f" == "$SOURCES_FILE" || "$f" == "${SOURCES_DIR}/werklade.list" ]] && continue
      hits+=("$f")
    done < <(grep -rlsF -- "pkg.werklade.de" /etc/apt/sources.list "$SOURCES_DIR" 2>/dev/null || true)
  fi
  if ((${#hits[@]})); then
    warn "Weitere Dateien verweisen auf pkg.werklade.de: ${hits[*]}. Nicht geändert."
  fi
}

do_setup() {
  check_system
  check_glibc
  warn_other_references
  ensure_tools
  setup_key
  setup_sources
  run apt-get update
}

do_remove() {
  check_system
  local f
  for f in "$SOURCES_FILE" "$KEY_FILE"; do
    if [[ -e "$f" ]]; then
      run rm -f -- "$f"
    else
      log "Nicht vorhanden: ${f}."
    fi
  done
  log "Installierte Pakete bleiben erhalten. Entfernen mit: apt remove werkterm"
  run apt-get update
}

main() {
  ORIG_ARGS=("$@")
  parse_args "$@"
  ensure_root
  ((DRY_RUN)) && log "Trockenlauf: es wird nichts geändert."
  case "$MODE" in
    remove) do_remove ;;
    install)
      do_setup
      run apt-get install -y "${PACKAGES[@]}"
      ;;
    *) do_setup ;;
  esac
  log "Fertig."
}

main "$@"
