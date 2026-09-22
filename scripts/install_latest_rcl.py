#!/usr/bin/env python3
"""Install and verify the latest published Review Council release."""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence
from urllib.parse import unquote, urlsplit

PACKAGE = "review-council"
LATEST_PACKAGE = "review-council@latest"
PUBLIC_REGISTRY = "https://registry.npmjs.org/"
TRUSTED_TEMP_ROOT = Path("/tmp")
WORKTREE_ROOT = Path(__file__).resolve().parents[1]
MAX_ATTEMPTS = 3
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


class InstallError(RuntimeError):
    """Raised when the latest release cannot be installed safely."""


@dataclass(frozen=True)
class Metadata:
    """Validated registry metadata for one exact release."""

    version: str
    integrity: str
    tarball: str
    digest: bytes


Runner = Callable[..., subprocess.CompletedProcess[str]]


def restricted_npm_runner(runner: Runner, node_bin: str) -> Runner:
    """Run npm with a minimal environment and no ambient Node/npm injection."""

    allowed = {
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "LANG",
        "LC_ALL",
        "NO_PROXY",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment["PATH"] = os.pathsep.join((str(Path(node_bin).parent), "/usr/bin", "/bin"))

    def run(command, **options):
        return runner(command, env=environment, **options)

    return run


def validate_approved_prefix(
    path_value: str, *, label: str = "approved prefix"
) -> tuple[Path, int, int]:
    """Validate and record an operator-approved runtime or installation prefix."""

    prefix = Path(path_value)
    if not prefix.is_absolute():
        raise InstallError(f"{label} must be absolute")
    try:
        prefix = prefix.resolve(strict=True)
    except FileNotFoundError as error:
        raise InstallError(f"{label} does not exist") from error
    if not prefix.is_dir() or WORKTREE_ROOT == prefix or WORKTREE_ROOT in prefix.parents:
        raise InstallError(f"{label} must be a directory outside the worktree")
    prefix_stat = prefix.stat()
    if prefix_stat.st_uid not in {0, os.geteuid()} or prefix_stat.st_mode & 0o002:
        raise InstallError(f"{label} has unsafe ownership or permissions")
    for ancestor in prefix.parents:
        ancestor_stat = ancestor.stat()
        if (
            ancestor_stat.st_uid not in {0, prefix_stat.st_uid}
            or ancestor_stat.st_mode & 0o002
            or (
                ancestor_stat.st_mode & 0o020
                and (
                    ancestor_stat.st_uid != prefix_stat.st_uid
                    or ancestor_stat.st_gid != prefix_stat.st_gid
                )
            )
        ):
            raise InstallError(f"{label} has an unsafe ancestor")
    return prefix, prefix_stat.st_uid, prefix_stat.st_gid


def validate_executable(
    path_value: str, label: str, prefix: Path, prefix_owner: int, prefix_group: int
) -> str:
    """Require an absolute, executable command path with safe ownership and modes."""

    original = Path(path_value)
    if not original.is_absolute():
        raise InstallError(f"{label} path must be absolute")
    if WORKTREE_ROOT == original or WORKTREE_ROOT in original.parents:
        raise InstallError(f"{label} path must not be inside the worktree")
    try:
        resolved = original.resolve(strict=True)
    except FileNotFoundError as error:
        raise InstallError(f"{label} path does not exist") from error
    if WORKTREE_ROOT == resolved or WORKTREE_ROOT in resolved.parents:
        raise InstallError(f"{label} path must not resolve inside the worktree")

    try:
        resolved.relative_to(prefix)
    except ValueError as error:
        raise InstallError(
            f"{label} path is outside the runtime prefix (--runtime-prefix)"
        ) from error

    for candidate in (resolved, *resolved.parents):
        candidate_stat = candidate.stat()
        if candidate == prefix:
            break
        if (
            candidate_stat.st_uid != prefix_owner
            or candidate_stat.st_gid != prefix_group
            or candidate_stat.st_mode & 0o002
        ):
            raise InstallError(f"{label} path has unsafe ownership or permissions")
    resolved_stat = resolved.stat()
    if not stat.S_ISREG(resolved_stat.st_mode) or not os.access(resolved, os.X_OK):
        raise InstallError(f"{label} path must resolve to an executable regular file")
    return str(resolved)


def validate_npm_runtime(
    npm_bin: str, node_bin: str, runtime_prefix: str
) -> tuple[str, str, str]:
    """Validate npm and Node against their operator-approved runtime prefix."""

    prefix, prefix_owner, prefix_group = validate_approved_prefix(
        runtime_prefix, label="runtime prefix"
    )
    npm_bin = validate_executable(
        npm_bin, "npm", prefix, prefix_owner, prefix_group
    )
    node_bin = validate_executable(
        node_bin, "node", prefix, prefix_owner, prefix_group
    )
    try:
        with Path(npm_bin).open(encoding="utf-8") as npm_file:
            shebang = npm_file.readline().strip()
    except (OSError, UnicodeError) as error:
        raise InstallError("npm executable has an unreadable shebang") from error
    if shebang not in {"#!/usr/bin/env node", f"#!{node_bin}"}:
        raise InstallError("npm executable must use the expected Node shebang")
    return npm_bin, node_bin, str(prefix)


def npm_command(node_bin: str, npm_bin: str, *arguments: str) -> tuple[str, ...]:
    """Build an npm command bound to the validated Node and npm files."""

    return (node_bin, npm_bin, *arguments)


@contextlib.contextmanager
def restrictive_umask():
    """Give npm pack a deterministic private creation mask."""

    previous = os.umask(0o077)
    try:
        yield
    finally:
        os.umask(previous)


def run_command(
    runner: Runner, command: Sequence[str]
) -> subprocess.CompletedProcess[str]:
    """Run one command and surface its failure with captured diagnostics."""

    try:
        return runner(command, check=True, text=True, capture_output=True)
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "no command output").strip()
        action = " ".join(command[:2])
        raise InstallError(f"{action} failed: {detail}") from error


def decode_sha512_sri(value: object) -> bytes:
    """Decode one exact SHA-512 Subresource Integrity value."""

    if not isinstance(value, str) or not value.startswith("sha512-"):
        raise InstallError("registry integrity must be one SHA-512 SRI value")
    try:
        digest = base64.b64decode(value.removeprefix("sha512-"), validate=True)
    except (ValueError, binascii.Error) as error:
        raise InstallError("registry integrity is not valid base64") from error
    if len(digest) != hashlib.sha512().digest_size:
        raise InstallError("registry integrity is not a SHA-512 digest")
    return digest


def parse_metadata(payload: str) -> Metadata:
    """Validate the version, integrity, and tarball returned by npm."""

    try:
        raw = json.loads(payload)
    except json.JSONDecodeError as error:
        raise InstallError("npm returned invalid registry metadata JSON") from error
    # npm 11+ serializes a single package result from `npm view … --json` as
    # an array. Accept exactly one release; multiple results remain ambiguous
    # and fail closed. The object check below validates the array item.
    if isinstance(raw, list):
        if len(raw) != 1:
            raise InstallError("npm registry metadata must contain exactly one release")
        raw = raw[0]
    if not isinstance(raw, dict):
        raise InstallError("npm registry metadata must be an object")

    version = raw.get("version")
    distribution = raw.get("dist")
    if not isinstance(distribution, dict):
        raise InstallError("npm registry metadata has no distribution object")
    integrity = distribution.get("integrity")
    tarball = distribution.get("tarball")
    if not isinstance(version, str) or not SEMVER_PATTERN.fullmatch(version):
        raise InstallError("registry version is not canonical SemVer")
    digest = decode_sha512_sri(integrity)
    if not isinstance(tarball, str):
        raise InstallError("registry tarball URL is missing")

    parsed_url = urlsplit(tarball)
    if (
        parsed_url.scheme != "https"
        or parsed_url.netloc != "registry.npmjs.org"
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise InstallError("registry tarball URL is not the expected public origin")
    directory, separator, encoded_filename = parsed_url.path.rpartition("/")
    if separator != "/" or directory != f"/{PACKAGE}/-":
        raise InstallError("registry tarball URL has an unexpected path")
    try:
        filename = unquote(encoded_filename, errors="strict")
    except UnicodeDecodeError as error:
        raise InstallError("registry tarball URL contains invalid encoding") from error
    if filename != f"{PACKAGE}-{version}.tgz":
        raise InstallError("registry tarball URL does not match its version")

    return Metadata(version, integrity, tarball, digest)


def query_metadata(node_bin: str, npm_bin: str, runner: Runner) -> Metadata:
    """Resolve and validate the latest registry tuple in one request."""

    result = run_command(
        runner,
        npm_command(
            node_bin,
            npm_bin,
            "view",
            LATEST_PACKAGE,
            "--json",
            f"--registry={PUBLIC_REGISTRY}",
        ),
    )
    return parse_metadata(result.stdout)


def parse_pack_result(payload: str, metadata: Metadata) -> str:
    """Validate npm pack output and return its safe tarball filename."""

    try:
        packed = json.loads(payload)
    except json.JSONDecodeError as error:
        raise InstallError("npm pack returned invalid JSON") from error
    # npm 11+ returns a package-name keyed object for a single `npm pack`
    # result. Normalize only the exact one-package shape before applying the
    # existing result-object, filename, version and integrity validation below.
    if isinstance(packed, dict):
        if set(packed) != {PACKAGE}:
            raise InstallError("npm pack must return exactly one package")
        packed = [packed[PACKAGE]]
    if not isinstance(packed, list) or len(packed) != 1:
        raise InstallError("npm pack must return exactly one package")
    package = packed[0]
    if not isinstance(package, dict):
        raise InstallError("npm pack result must be an object")
    filename = package.get("filename")
    expected_filename = f"{PACKAGE}-{metadata.version}.tgz"
    if filename != expected_filename:
        raise InstallError("npm pack returned an unsafe filename")
    if package.get("version") != metadata.version:
        raise InstallError("packed version differs from registry metadata")
    if package.get("integrity") != metadata.integrity:
        raise InstallError("packed integrity differs from registry metadata")
    return filename


def validate_temp_root(root: Path = TRUSTED_TEMP_ROOT) -> Path:
    """Require a canonical root-owned sticky temp directory and safe ancestors."""

    canonical = root.resolve(strict=True)
    root_stat = canonical.stat()
    if (
        not stat.S_ISDIR(root_stat.st_mode)
        or root_stat.st_uid != 0
        or not root_stat.st_mode & stat.S_ISVTX
    ):
        raise InstallError("trusted temp root must be a root-owned sticky directory")
    for ancestor in canonical.parents:
        ancestor_stat = ancestor.stat()
        if ancestor_stat.st_uid != 0 or ancestor_stat.st_mode & 0o022:
            raise InstallError("trusted temp root has an unsafe ancestor")
    return canonical


def verify_tarball(path: Path, metadata: Metadata) -> tuple[int, int, int, int]:
    """Verify tarball ownership, inode metadata, and SHA-512 digest."""

    file_stat = path.lstat()
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or path.is_symlink()
        or file_stat.st_uid != os.geteuid()
        or file_stat.st_mode & 0o022
    ):
        raise InstallError("packed artifact must be one owned, non-writable regular file")
    digest = hashlib.sha512()
    with path.open("rb") as package:
        for chunk in iter(lambda: package.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.digest() != metadata.digest:
        raise InstallError("packed artifact SHA-512 differs from registry metadata")
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_size,
        file_stat.st_mtime_ns,
    )


def installed_version(
    node_bin: str, npm_bin: str, approved_prefix: str, runner: Runner
) -> str | None:
    """Read the globally installed package version without executing RCL."""

    command = npm_command(
        node_bin,
        npm_bin,
        "list",
        "-g",
        PACKAGE,
        "--depth=0",
        "--json",
        f"--prefix={approved_prefix}",
        f"--registry={PUBLIC_REGISTRY}",
    )
    result = runner(command, check=False, text=True, capture_output=True)
    if result.returncode not in (0, 1):
        detail = (result.stderr or result.stdout or "no command output").strip()
        raise InstallError(f"{npm_bin} list failed: {detail}")
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as error:
        raise InstallError("npm list returned invalid JSON") from error
    dependencies = payload.get("dependencies", {}) if isinstance(payload, dict) else {}
    package = dependencies.get(PACKAGE) if isinstance(dependencies, dict) else None
    version = package.get("version") if isinstance(package, dict) else None
    if result.returncode != 0 and version is not None:
        raise InstallError("npm reports a broken global RCL installation")
    if version is None:
        return None
    if not isinstance(version, str) or not SEMVER_PATTERN.fullmatch(version):
        raise InstallError("installed package version is not canonical SemVer")
    return version


def uninstall_rcl(
    node_bin: str, npm_bin: str, approved_prefix: str, runner: Runner
) -> None:
    """Remove an installation that failed post-install verification."""

    run_command(
        runner,
        npm_command(
            node_bin,
            npm_bin,
            "uninstall",
            "-g",
            PACKAGE,
            "--ignore-scripts",
            f"--prefix={approved_prefix}",
            f"--registry={PUBLIC_REGISTRY}",
        ),
    )


def install_latest_rcl(
    npm_bin: str,
    node_bin: str,
    approved_prefix: str,
    *,
    runtime_prefix: str | None = None,
    runner: Runner = subprocess.run,
) -> str:
    """Install latest RCL with separately validated runtime and destination paths."""

    install_prefix, _owner, _group = validate_approved_prefix(
        approved_prefix, label="installation prefix"
    )
    approved_prefix = str(install_prefix)
    npm_bin, node_bin, _runtime_prefix = validate_npm_runtime(
        npm_bin, node_bin,
        approved_prefix if runtime_prefix is None else runtime_prefix,
    )
    runner = restricted_npm_runner(runner, node_bin)
    temp_root = validate_temp_root()

    metadata = query_metadata(node_bin, npm_bin, runner)
    installed_version(node_bin, npm_bin, approved_prefix, runner)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt > 1:
            metadata = query_metadata(node_bin, npm_bin, runner)
        with tempfile.TemporaryDirectory(
            prefix="rcl-install-", dir=temp_root
        ) as package_dir:
            package_root = Path(package_dir).resolve(strict=True)
            package_root_stat = package_root.stat()
            if package_root_stat.st_uid != os.geteuid() or stat.S_IMODE(
                package_root_stat.st_mode
            ) != 0o700:
                raise InstallError("package temp directory has unsafe ownership or mode")
            with restrictive_umask():
                pack = run_command(
                    runner,
                    npm_command(
                        node_bin,
                        npm_bin,
                        "pack",
                        PACKAGE + "@" + metadata.version,
                        "--ignore-scripts",
                        "--json",
                        "--pack-destination",
                        package_dir,
                        f"--registry={PUBLIC_REGISTRY}",
                    ),
                )
            filename = parse_pack_result(pack.stdout, metadata)
            package_path = package_root / filename
            if package_path.is_symlink():
                raise InstallError("packed artifact must not be a symlink")
            resolved_package_path = package_path.resolve(strict=True)
            if resolved_package_path.parent != package_root:
                raise InstallError("packed artifact escaped its temporary directory")
            if list(package_root.iterdir()) != [package_path]:
                raise InstallError("npm pack created unexpected files")
            verified_fingerprint = verify_tarball(package_path, metadata)

            if query_metadata(node_bin, npm_bin, runner) != metadata:
                print(
                    f"RCL latest metadata changed before install; retrying ({attempt}/{MAX_ATTEMPTS})",
                    file=sys.stderr,
                )
                continue

            run_command(
                runner,
                npm_command(
                    node_bin,
                    npm_bin,
                    "install",
                    "-g",
                    "--ignore-scripts",
                    str(package_path),
                    f"--prefix={approved_prefix}",
                    f"--registry={PUBLIC_REGISTRY}",
                ),
            )
            try:
                post_install_fingerprint = verify_tarball(package_path, metadata)
            except InstallError:
                uninstall_rcl(node_bin, npm_bin, approved_prefix, runner)
                raise
            if post_install_fingerprint != verified_fingerprint:
                uninstall_rcl(node_bin, npm_bin, approved_prefix, runner)
                raise InstallError("packed artifact changed while npm installed it")
            if query_metadata(node_bin, npm_bin, runner) != metadata:
                uninstall_rcl(node_bin, npm_bin, approved_prefix, runner)
                print(
                    f"RCL latest metadata changed after install; retrying ({attempt}/{MAX_ATTEMPTS})",
                    file=sys.stderr,
                )
                continue
            if (
                installed_version(node_bin, npm_bin, approved_prefix, runner)
                != metadata.version
            ):
                uninstall_rcl(node_bin, npm_bin, approved_prefix, runner)
                raise InstallError("installed rcl version differs from latest metadata")
            return metadata.version

    raise InstallError(
        f"RCL latest metadata changed during {MAX_ATTEMPTS} consecutive attempts"
    )


def main() -> int:
    """Install latest RCL for CI or an explicitly authorized local workflow."""

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--npm-bin", required=True, help="absolute npm executable"
    )
    parser.add_argument(
        "--node-bin", required=True, help="absolute Node executable"
    )
    parser.add_argument(
        "--approved-prefix",
        required=True,
        help="operator-approved global RCL installation prefix",
    )
    parser.add_argument(
        "--runtime-prefix",
        help="operator-approved prefix containing npm and Node (default: --approved-prefix)",
    )
    arguments = parser.parse_args()
    try:
        version = install_latest_rcl(
            arguments.npm_bin, arguments.node_bin, arguments.approved_prefix,
            runtime_prefix=arguments.runtime_prefix,
        )
    except (InstallError, OSError, subprocess.CalledProcessError) as error:
        print(f"RCL installation failed: {error}", file=sys.stderr)
        return 1
    print(f"Installed and verified latest RCL release: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
