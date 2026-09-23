# Recover encrypted review evidence

The Review Council gate retains its exported evidence and quarantine files as
one authenticated CMS ciphertext. The GitHub artifact is public to repository
readers, but its contents are recoverable only with the separately held private
key. Use this runbook only from an approved operator workstation. Do not run it
in GitHub Actions, paste key material into a terminal, or enable shell tracing.

Recovery produces a new read-only directory containing byte-for-byte copies of
the retained originals. It does not deliver evidence to Harness, change review
accounting, establish convergence, or approve a pull request.

## Current recipient mapping

The committed recipient and the private-key version are a single rotation unit:

| Field | Version 1 value |
| --- | --- |
| Committed certificate | `.github/review-evidence-recovery.pem` |
| Certificate SHA-256 fingerprint | `32:8A:57:76:11:C1:EC:F0:AA:8E:A0:9A:A4:75:EF:C0:96:F6:95:59:10:E5:F4:89:E8:7F:C3:F3:E0:1D:69:2B` |
| Certificate file SHA-256 | `178ce65433e375596bba087528fc7c32d8cd396405c40ed3e2d2f1a7f411554b` |
| Secret | `projects/2989947634/secrets/rcl-review-evidence-recovery-private-key-v1` |
| Exact secret version | `projects/2989947634/secrets/rcl-review-evidence-recovery-private-key-v1/versions/1` |
| Certificate validity | 2026-09-23 12:18:44 UTC through 2027-10-28 12:18:44 UTC |

Always select the private-key version from this mapping. Never use `latest`.
Version 1 was independently checked against the committed certificate without
printing or persistently downloading the private key.

## Prerequisites

You need:

- repository Actions read access through `gh auth`;
- approved access to the exact Google Secret Manager version above;
- OpenSSL 3 with CMS AES-256-GCM support, Python 3, `jq`, and `gh`;
- the workflow run ID and attempt, plus the artifact ID and 64-character
  SHA-256 digest recorded in that run's **Record retained evidence receipt**
  step summary.

Perform recovery in a private local temporary directory. The commands below do
not change GitHub, Secret Manager, IAM, the workflow, or Harness.

## Locate and authenticate the immutable artifact

Set the receipt values explicitly. The expected ID and digest must come from
the workflow step summary, not from the artifact API response being checked.

```sh
set -euo pipefail
set +x
umask 077

REPOSITORY=allocator-one/rcl
: "${RUN_ID:?set the workflow run ID from the receipt}"
: "${RUN_ATTEMPT:?set the workflow run attempt from the receipt}"
: "${EXPECTED_ARTIFACT_ID:?set the artifact ID from the receipt}"
: "${EXPECTED_ARTIFACT_DIGEST:?set the artifact digest from the receipt}"
ARTIFACT_NAME="review-gate-encrypted-${RUN_ID}-${RUN_ATTEMPT}"

case "$RUN_ID:$RUN_ATTEMPT:$EXPECTED_ARTIFACT_ID" in
  *[!0-9:]*|'') echo "receipt IDs must be decimal numbers" >&2; exit 1 ;;
esac
case "$EXPECTED_ARTIFACT_DIGEST" in
  *[!0-9a-f]*|'') echo "artifact digest must be lowercase hexadecimal" >&2; exit 1 ;;
esac
test "${#EXPECTED_ARTIFACT_DIGEST}" -eq 64

RCL_RECOVERY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rcl-review-recovery.XXXXXX")"
PRIVATE_KEY="$RCL_RECOVERY_ROOT/recovery-key.pem"
cleanup() {
  chmod 600 "$PRIVATE_KEY" 2>/dev/null || true
  rm -f "$PRIVATE_KEY"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$REPOSITORY/actions/runs/$RUN_ID/artifacts?per_page=100" |
  jq --arg name "$ARTIFACT_NAME" '
    [.artifacts[] | select(.name == $name)] |
    if length == 1 then .[0]
    else error("expected exactly one artifact named " + $name)
    end
  ' > "$RCL_RECOVERY_ROOT/artifact.json"

test "$(jq -er '.id' "$RCL_RECOVERY_ROOT/artifact.json")" = "$EXPECTED_ARTIFACT_ID"
test "$(jq -er '.expired' "$RCL_RECOVERY_ROOT/artifact.json")" = false
test "$(jq -er '.workflow_run.id' "$RCL_RECOVERY_ROOT/artifact.json")" = "$RUN_ID"
API_DIGEST="$(jq -er '.digest | select(startswith("sha256:")) | sub("^sha256:"; "")' \
  "$RCL_RECOVERY_ROOT/artifact.json")"
test "$API_DIGEST" = "$EXPECTED_ARTIFACT_DIGEST"

gh api --method GET \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$REPOSITORY/actions/artifacts/$EXPECTED_ARTIFACT_ID/zip" \
  > "$RCL_RECOVERY_ROOT/artifact.zip"

DOWNLOADED_DIGEST="$(openssl dgst -sha256 "$RCL_RECOVERY_ROOT/artifact.zip" |
  awk '{print $NF}')"
test "$DOWNLOADED_DIGEST" = "$EXPECTED_ARTIFACT_DIGEST"
```

GitHub Actions artifacts are immutable by ID. The REST metadata uses a
`sha256:`-prefixed digest, while the workflow step summary records the same
digest as 64 lowercase hexadecimal characters. Keep `artifact.json` with the
recovery receipt.

## Validate the ciphertext-only artifact

The artifact ZIP must contain exactly one regular file named
`review-evidence.cms`. Validate names, type, size, CRC, and content before
writing that file. Do not use a general-purpose unzip command.

```sh
python3 - "$RCL_RECOVERY_ROOT/artifact.zip" "$RCL_RECOVERY_ROOT/review-evidence.cms" <<'PYZIP'
import os
import shutil
import stat
import sys
import zipfile
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
maximum_ciphertext_bytes = 1_100_000_000

with zipfile.ZipFile(source) as archive:
    members = archive.infolist()
    if len(members) != 1:
        raise SystemExit("artifact must contain exactly one member")
    member = members[0]
    if member.filename != "review-evidence.cms" or member.is_dir():
        raise SystemExit("artifact member must be review-evidence.cms")
    mode = member.external_attr >> 16
    file_type = stat.S_IFMT(mode)
    if file_type not in (0, stat.S_IFREG):
        raise SystemExit("artifact member must be a regular file")
    if member.flag_bits & 1:
        raise SystemExit("artifact ZIP member must not use ZIP encryption")
    if not 0 < member.file_size <= maximum_ciphertext_bytes:
        raise SystemExit("ciphertext size is outside the recovery bound")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with archive.open(member) as reader, os.fdopen(descriptor, "wb") as writer:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    if destination.stat().st_size != member.file_size:
        raise SystemExit("ciphertext size changed during extraction")
PYZIP

test "$(find "$RCL_RECOVERY_ROOT" -maxdepth 1 -type f -name 'review-evidence.cms' | wc -l | tr -d ' ')" = 1
openssl cms -cmsout -inform DER \
  -in "$RCL_RECOVERY_ROOT/review-evidence.cms" -noout

CERTIFICATE=.github/review-evidence-recovery.pem
EXPECTED_CERT_FINGERPRINT='32:8A:57:76:11:C1:EC:F0:AA:8E:A0:9A:A4:75:EF:C0:96:F6:95:59:10:E5:F4:89:E8:7F:C3:F3:E0:1D:69:2B'
ACTUAL_CERT_FINGERPRINT="$(openssl x509 -in "$CERTIFICATE" -noout -fingerprint -sha256 |
  sed 's/^sha256 Fingerprint=//')"
test "$ACTUAL_CERT_FINGERPRINT" = "$EXPECTED_CERT_FINGERPRINT"
```

## Access the exact private-key version and decrypt

Do this only with approved access. Redirect the secret payload directly to a
mode-0600 file; never place it in an environment variable, command argument,
log, clipboard, shell trace, or GitHub Actions job.

```sh
GCP_PROJECT=2989947634
SECRET_NAME=rcl-review-evidence-recovery-private-key-v1
SECRET_VERSION=1

(umask 077 && gcloud secrets versions access "$SECRET_VERSION" \
  --secret "$SECRET_NAME" \
  --project "$GCP_PROJECT" > "$PRIVATE_KEY")
chmod 600 "$PRIVATE_KEY"
KEY_MODE="$(stat -f '%Lp' "$PRIVATE_KEY" 2>/dev/null || stat -c '%a' "$PRIVATE_KEY")"
test "$KEY_MODE" = 600

CERT_PUBLIC_KEY_SHA="$(openssl x509 -in "$CERTIFICATE" -pubkey -noout |
  openssl pkey -pubin -outform DER |
  openssl dgst -sha256 | awk '{print $NF}')"
PRIVATE_PUBLIC_KEY_SHA="$(openssl pkey -in "$PRIVATE_KEY" -pubout -outform DER |
  openssl dgst -sha256 | awk '{print $NF}')"
test "$PRIVATE_PUBLIC_KEY_SHA" = "$CERT_PUBLIC_KEY_SHA"

openssl cms -decrypt -binary -inform DER \
  -in "$RCL_RECOVERY_ROOT/review-evidence.cms" \
  -recip "$CERTIFICATE" \
  -inkey "$PRIVATE_KEY" \
  -out "$RCL_RECOVERY_ROOT/recovered.tar.partial"
chmod 600 "$RCL_RECOVERY_ROOT/recovered.tar.partial"
mv "$RCL_RECOVERY_ROOT/recovered.tar.partial" "$RCL_RECOVERY_ROOT/recovered.tar"
rm -f "$PRIVATE_KEY"
```

A wrong key, modified ciphertext, or failed authentication must stop recovery.
Do not inspect or extract any partial plaintext from a failed decrypt.

## Verify the internal manifest before extraction

The decrypted TAR is untrusted. The following verifier rejects absolute or
non-canonical paths, traversal, links, devices, duplicate members, unexpected
roots, an oversized manifest, undeclared files, size differences, and SHA-256
differences. It validates every retained byte before creating the output
directory, then writes each original once with mode 0400 and rechecks its hash.

```sh
python3 - "$RCL_RECOVERY_ROOT/recovered.tar" "$RCL_RECOVERY_ROOT/validated-originals" <<'PYMANIFEST'
import hashlib
import json
import os
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
staging = destination.with_name(destination.name + ".partial")
manifest_limit = 1024 * 1024
digest_pattern = re.compile(r"[0-9a-f]{64}")

def safe_name(name):
    if not name or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return (
        not path.is_absolute()
        and str(path) == name
        and all(part not in ("", ".", "..") for part in path.parts)
    )

def hash_member(archive, member):
    stream = archive.extractfile(member)
    if stream is None:
        raise SystemExit(f"cannot read archive member: {member.name}")
    digest = hashlib.sha256()
    total = 0
    while chunk := stream.read(1024 * 1024):
        total += len(chunk)
        if total > member.size:
            raise SystemExit(f"member grew while reading: {member.name}")
        digest.update(chunk)
    if total != member.size:
        raise SystemExit(f"member size changed while reading: {member.name}")
    return digest.hexdigest()

def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value

with tarfile.open(source, mode="r:") as archive:
    members = archive.getmembers()
    names = [member.name for member in members]
    if len(names) != len(set(names)):
        raise SystemExit("archive contains duplicate member names")
    if any(not safe_name(name) for name in names):
        raise SystemExit("archive contains an unsafe or non-canonical path")
    if any(not member.isreg() for member in members):
        raise SystemExit("archive contains a non-regular member")
    if names.count("MANIFEST.json") != 1:
        raise SystemExit("archive must contain one MANIFEST.json")

    manifest_member = archive.getmember("MANIFEST.json")
    if manifest_member.size > manifest_limit:
        raise SystemExit("manifest exceeds 1 MiB")
    manifest_stream = archive.extractfile(manifest_member)
    if manifest_stream is None:
        raise SystemExit("manifest is unreadable")
    manifest = json.loads(
        manifest_stream.read(manifest_limit + 1), object_pairs_hook=unique_object
    )
    if not isinstance(manifest, dict) or set(manifest) != {"files", "schema"}:
        raise SystemExit("manifest object has unexpected fields")
    if manifest["schema"] != "rcl-review-evidence-archive-v1":
        raise SystemExit("manifest schema is unsupported")
    if not isinstance(manifest["files"], list):
        raise SystemExit("manifest files must be an array")

    declarations = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or set(entry) != {"bytes", "path", "sha256"}:
            raise SystemExit("manifest file entry has unexpected fields")
        path = entry["path"]
        size = entry["bytes"]
        digest = entry["sha256"]
        if not isinstance(path, str) or not safe_name(path):
            raise SystemExit("manifest contains an unsafe path")
        if not (path.startswith("evidence/") or path.startswith("quarantine/")):
            raise SystemExit(f"manifest path has an unexpected root: {path}")
        if path in declarations:
            raise SystemExit(f"manifest path is duplicated: {path}")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise SystemExit(f"manifest size is invalid: {path}")
        if not isinstance(digest, str) or digest_pattern.fullmatch(digest) is None:
            raise SystemExit(f"manifest digest is invalid: {path}")
        declarations[path] = (size, digest)

    retained_names = set(names) - {"MANIFEST.json"}
    if retained_names != set(declarations):
        raise SystemExit("manifest and archive member sets differ")
    for name, (expected_size, expected_digest) in declarations.items():
        member = archive.getmember(name)
        if member.size != expected_size:
            raise SystemExit(f"manifest size differs: {name}")
        if hash_member(archive, member) != expected_digest:
            raise SystemExit(f"manifest digest differs: {name}")

    if destination.exists() or staging.exists():
        raise SystemExit("recovery output already exists")
    staging.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name in sorted(declarations):
        member = archive.getmember(name)
        output = staging.joinpath(*PurePosixPath(name).parts)
        output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(
            output,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o400,
        )
        digest = hashlib.sha256()
        total = 0
        stream = archive.extractfile(member)
        if stream is None:
            raise SystemExit(f"cannot reread archive member: {name}")
        with os.fdopen(descriptor, "wb") as writer:
            while chunk := stream.read(1024 * 1024):
                total += len(chunk)
                digest.update(chunk)
                writer.write(chunk)
        expected_size, expected_digest = declarations[name]
        if total != expected_size or digest.hexdigest() != expected_digest:
            raise SystemExit(f"member changed during extraction: {name}")
        output.chmod(0o400)
    staging.rename(destination)
PYMANIFEST
```

Preserve `artifact.json`, `artifact.zip`, `review-evidence.cms`,
`recovered.tar`, and `validated-originals` together under the private recovery
root until the incident or recovery is reconciled. Record their SHA-256 hashes,
the workflow run and attempt, artifact ID, and recovery operator in the
restricted operational record. Never edit files under `validated-originals`;
make separate working copies if analysis needs writable data.

## Rotation and retention

Each certificate fingerprint must map to one exact Secret Manager version in
this document before the workflow encrypts with it. Rotation must add and
verify a new mapping before changing the committed certificate. It must not
replace or relabel an old mapping.

Keep every old private-key version enabled and recoverable for at least the
full GitHub artifact lifetime measured from the last successful encryption
with its certificate. The current workflow retains artifacts for 30 days, but
use the artifact API's actual `expires_at` value when it is later or retention
was extended. Do not disable or destroy a version while any corresponding
artifact exists, is under a recovery hold, or has not completed independent
reconciliation. Certificate expiry is not permission to destroy its key.

This runbook does not authorize generating or rotating keys, adding secret
versions, changing IAM, editing Actions, accessing unrelated artifacts, or
deleting recovery material. Those operations require their own approved
change and audit trail. A successful decrypt proves only that the retained
ciphertext was readable with the mapped key; it does not prove review quality,
CI success, attestation, convergence, or merge readiness.
