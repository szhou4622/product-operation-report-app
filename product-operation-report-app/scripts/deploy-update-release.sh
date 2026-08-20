#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ProductOperationReport"
UPDATE_ROOT="${UPDATE_ROOT:-/opt/original-video-dedup-update}"
PUBLIC_ROOT="${PUBLIC_ROOT:-https://update.dadaozixun.com/product-operation-report/releases}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/latest.json"

if [[ ! -f "${MANIFEST}" ]]; then
  echo "ERROR: latest.json not found in release package" >&2
  exit 1
fi

VERSION="$(python3 - "${MANIFEST}" "${SCRIPT_DIR}" "${PUBLIC_ROOT}" <<'PY'
import hashlib
import json
import pathlib
import re
import sys
from urllib.parse import quote

manifest_path = pathlib.Path(sys.argv[1])
release_dir = pathlib.Path(sys.argv[2])
public_root = sys.argv[3].rstrip("/")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

if manifest.get("app_name") != "ProductOperationReport":
    raise SystemExit("ERROR: app_name mismatch")
version = str(manifest.get("version", ""))
if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
    raise SystemExit("ERROR: invalid version")
if not isinstance(manifest.get("force"), bool):
    raise SystemExit("ERROR: force must be boolean")
if not isinstance(manifest.get("notes"), list) or not all(isinstance(item, str) for item in manifest["notes"]):
    raise SystemExit("ERROR: notes must be a string array")

files = {
    "windows_x64": f"Product-Operation-Report-Windows-{version}-x64-Setup.exe",
    "mac_arm64": f"Product-Operation-Report-macOS-{version}-arm64.dmg",
    "mac_x64": f"Product-Operation-Report-macOS-{version}-x64.dmg",
}
downloads = manifest.get("download_url")
checksums = manifest.get("sha256")
if not isinstance(downloads, dict) or set(downloads) != set(files):
    raise SystemExit("ERROR: download_url platform set mismatch")
if not isinstance(checksums, dict) or set(checksums) != set(files):
    raise SystemExit("ERROR: sha256 platform set mismatch")

for key, filename in files.items():
    path = release_dir / filename
    if not path.is_file():
        raise SystemExit(f"ERROR: missing artifact {filename}")
    expected_url = f"{public_root}/{version}/{quote(filename)}"
    if downloads[key] != expected_url:
        raise SystemExit(f"ERROR: download URL mismatch for {key}")
    expected_hash = str(checksums[key]).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise SystemExit(f"ERROR: invalid SHA256 for {key}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    actual_hash = digest.hexdigest()
    if actual_hash != expected_hash:
        raise SystemExit(f"ERROR: SHA256 mismatch for {key}")

print(version)
PY
)"

RELEASE_ROOT="${UPDATE_ROOT}/product-operation-report/releases"
TARGET_RELEASE="${RELEASE_ROOT}/${VERSION}"
MANIFEST_DIR="${UPDATE_ROOT}/apps/${APP_NAME}"
BACKUP_DIR="${UPDATE_ROOT}/backups/${APP_NAME}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TEMP_RELEASE="${RELEASE_ROOT}/.${APP_NAME}-${VERSION}-${TIMESTAMP}"

install -d -m 0755 "${RELEASE_ROOT}" "${MANIFEST_DIR}" "${BACKUP_DIR}"
trap 'rm -rf -- "${TEMP_RELEASE}"' EXIT
install -d -m 0755 "${TEMP_RELEASE}"

for file in \
  "Product-Operation-Report-Windows-${VERSION}-x64-Setup.exe" \
  "Product-Operation-Report-macOS-${VERSION}-arm64.dmg" \
  "Product-Operation-Report-macOS-${VERSION}-x64.dmg"; do
  install -m 0644 "${SCRIPT_DIR}/${file}" "${TEMP_RELEASE}/${file}"
done

if [[ -d "${TARGET_RELEASE}" ]]; then
  for file in "${TEMP_RELEASE}"/*; do
    target="${TARGET_RELEASE}/$(basename -- "${file}")"
    if [[ ! -f "${target}" ]] || ! cmp -s -- "${file}" "${target}"; then
      echo "ERROR: release ${VERSION} already exists with different files" >&2
      exit 1
    fi
  done
  rm -rf -- "${TEMP_RELEASE}"
else
  mv -- "${TEMP_RELEASE}" "${TARGET_RELEASE}"
fi

if [[ -f "${MANIFEST_DIR}/latest.json" ]]; then
  cp -p -- "${MANIFEST_DIR}/latest.json" "${BACKUP_DIR}/latest-${TIMESTAMP}.json"
fi
install -m 0644 "${MANIFEST}" "${MANIFEST_DIR}/latest.json.tmp-${TIMESTAMP}"
mv -f -- "${MANIFEST_DIR}/latest.json.tmp-${TIMESTAMP}" "${MANIFEST_DIR}/latest.json"

trap - EXIT
echo "UPDATE_RELEASE_DEPLOYED=true"
echo "app_name=${APP_NAME}"
echo "version=${VERSION}"
echo "manifest=${MANIFEST_DIR}/latest.json"
echo "release=${TARGET_RELEASE}"
