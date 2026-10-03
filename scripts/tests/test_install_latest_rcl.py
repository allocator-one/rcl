import base64
import contextlib
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import install_latest_rcl


class FakeRunner:
    def __init__(
        self,
        metadata_payloads,
        package_bytes=b"review council",
        reported_bytes=None,
        extra_pack_file=False,
        list_version_override=None,
        list_returncode_override=None,
        mutate_after_install=False,
        pack_as_object=False,
    ):
        self.metadata_payloads = iter(metadata_payloads)
        self.package_bytes = package_bytes
        self.reported_bytes = reported_bytes or package_bytes
        self.extra_pack_file = extra_pack_file
        self.list_version_override = list_version_override
        self.list_returncode_override = list_returncode_override
        self.mutate_after_install = mutate_after_install
        self.pack_as_object = pack_as_object
        self.calls = []
        self.options = []
        self.installed_version = None
        self.legacy_version = None

    def __call__(self, command, **options):
        command = tuple(command)
        self.calls.append(command)
        self.options.append(options)
        action = command[2]
        if action == "view":
            return self.completed(command, next(self.metadata_payloads))
        if action == "pack":
            destination = Path(command[command.index("--pack-destination") + 1])
            version = command[3].rsplit("@", 1)[1]
            filename = f"allocator-one-rcl-{version}.tgz"
            (destination / filename).write_bytes(self.package_bytes)
            if self.extra_pack_file:
                (destination / "unexpected").write_text("unexpected")
            integrity = sri(self.reported_bytes)
            package = {
                "filename": filename,
                "version": version,
                "integrity": integrity,
            }
            result = {"@allocator-one/rcl": package} if self.pack_as_object else [package]
            return self.completed(command, json.dumps(result))
        if action == "install":
            package_path = next(value for value in command if value.endswith(".tgz"))
            self.installed_version = package_path.split("allocator-one-rcl-", 1)[1]
            self.installed_version = self.installed_version.removesuffix(".tgz")
            if self.mutate_after_install:
                Path(package_path).write_bytes(b"tampered after install")
            return self.completed(command, "")
        if action == "uninstall":
            if command[4] == "review-council":
                self.legacy_version = None
            else:
                self.installed_version = None
            return self.completed(command, "")
        if action == "list":
            dependencies = {}
            returncode = 1
            if command[4] == "review-council":
                if self.legacy_version is not None:
                    dependencies["review-council"] = {"version": self.legacy_version}
                    returncode = 0
            elif self.installed_version is not None:
                version = self.list_version_override or self.installed_version
                dependencies["@allocator-one/rcl"] = {"version": version}
                returncode = self.list_returncode_override or 0
            return self.completed(
                command, json.dumps({"dependencies": dependencies}), returncode
            )
        raise AssertionError(f"unexpected command: {command}")

    @staticmethod
    def completed(command, stdout, returncode=0):
        return subprocess.CompletedProcess(
            command, returncode, stdout=stdout, stderr=""
        )


def sri(content):
    digest = base64.b64encode(hashlib.sha512(content).digest()).decode()
    return "sha512-" + digest


def metadata(version="2.1.3", content=b"review council", tarball=None):
    return json.dumps(
        {
            "version": version,
            "dist": {
                "integrity": sri(content),
                "tarball": tarball
                or f"https://registry.npmjs.org/@allocator-one/rcl/-/rcl-{version}.tgz",
            },
        }
    )


class MetadataTest(unittest.TestCase):
    def test_accepts_npm_singleton_metadata_array(self):
        parsed = install_latest_rcl.parse_metadata(f"[{metadata()}]")

        self.assertEqual(parsed.version, "2.1.3")

    def test_accepts_stable_prerelease_and_build_metadata_versions(self):
        for version, filename_version in (
            ("2.1.3", "2.1.3"),
            ("3.0.0-rc.1", "3.0.0-rc.1"),
            ("3.0.0+build.7", "3.0.0%2Bbuild.7"),
        ):
            with self.subTest(version=version):
                tarball = (
                    "https://registry.npmjs.org/@allocator-one/rcl/-/"
                    f"rcl-{filename_version}.tgz"
                )
                parsed = install_latest_rcl.parse_metadata(
                    metadata(version=version, tarball=tarball)
                )
                self.assertEqual(parsed.version, version)

    def test_accepts_the_single_result_array_returned_by_npm(self):
        payload = metadata()
        parsed = install_latest_rcl.parse_metadata(json.dumps([json.loads(payload)]))

        self.assertEqual(parsed, install_latest_rcl.parse_metadata(payload))

    def test_rejects_empty_multiple_and_non_object_registry_results(self):
        release = json.loads(metadata())
        for result in ([], [release, release], [None], [[release]]):
            with self.subTest(result=result), self.assertRaises(
                install_latest_rcl.InstallError
            ):
                install_latest_rcl.parse_metadata(json.dumps(result))

    def test_rejects_invalid_version_integrity_origin_and_path(self):
        cases = (
            "not JSON",
            "[]",
            f"[{metadata()}, {metadata()}]",
            metadata(version="v2.1.3"),
            json.dumps(
                {
                    "version": "2.1.3",
                    "dist": {
                        "integrity": "sha512-invalid",
                        "tarball": "https://registry.npmjs.org/@allocator-one/rcl/-/rcl-2.1.3.tgz",
                    },
                }
            ),
            metadata(tarball="https://example.com/rcl-2.1.3.tgz"),
            metadata(
                tarball="https://registry.npmjs.org/other/-/rcl-2.1.3.tgz"
            ),
            metadata(
                tarball="https://registry.npmjs.org/review-council/-/review-council-2.1.3.tgz"
            ),
            metadata(
                tarball="https://registry.npmjs.org/@allocator-one/rcl/-/allocator-one-rcl-2.1.3.tgz"
            ),
        )
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(
                install_latest_rcl.InstallError
            ):
                install_latest_rcl.parse_metadata(payload)
            if payload != "not JSON":
                with self.subTest(array_payload=payload), self.assertRaises(
                    install_latest_rcl.InstallError
                ):
                    install_latest_rcl.parse_metadata(json.dumps([json.loads(payload)]))

    def test_rejects_multiple_unsafe_or_mismatched_pack_results(self):
        expected = install_latest_rcl.parse_metadata(metadata())
        cases = (
            [],
            [{}, {}],
            [
                {
                    "filename": "../package.tgz",
                    "version": "2.1.3",
                    "integrity": expected.integrity,
                }
            ],
            [
                {
                    "filename": "package.tgz",
                    "version": "2.1.4",
                    "integrity": expected.integrity,
                }
            ],
            [
                {
                    "filename": "package.tgz",
                    "version": "2.1.3",
                    "integrity": "sha512-wrong",
                }
            ],
        )
        for packed in cases:
            with self.subTest(packed=packed), self.assertRaises(
                install_latest_rcl.InstallError
            ):
                install_latest_rcl.parse_pack_result(json.dumps(packed), expected)
            if len(packed) == 1:
                with self.subTest(keyed_package=packed[0]), self.assertRaises(
                    install_latest_rcl.InstallError
                ):
                    install_latest_rcl.parse_pack_result(
                        json.dumps({"@allocator-one/rcl": packed[0]}), expected
                    )

    def test_rejects_empty_multiple_wrong_package_and_non_object_pack_results(self):
        expected = install_latest_rcl.parse_metadata(metadata())
        package = {
            "filename": "allocator-one-rcl-2.1.3.tgz",
            "version": "2.1.3",
            "integrity": expected.integrity,
        }
        for result in (
            {}, {"other-package": package}, {"review-council": package},
            {"@allocator-one/rcl": package, "other-package": package},
            {"@allocator-one/rcl": None}, {"@allocator-one/rcl": [package]},
        ):
            with self.subTest(result=result), self.assertRaises(
                install_latest_rcl.InstallError
            ):
                install_latest_rcl.parse_pack_result(json.dumps(result), expected)

    def test_accepts_npm_package_keyed_pack_result(self):
        expected = install_latest_rcl.parse_metadata(metadata())
        packed = {
            "@allocator-one/rcl": {
                "filename": "allocator-one-rcl-2.1.3.tgz",
                "version": "2.1.3",
                "integrity": expected.integrity,
            }
        }

        self.assertEqual(
            install_latest_rcl.parse_pack_result(json.dumps(packed), expected),
            "allocator-one-rcl-2.1.3.tgz",
        )

    def test_rejects_tarball_bytes_that_do_not_match_integrity(self):
        expected = install_latest_rcl.parse_metadata(metadata())
        with tempfile.TemporaryDirectory() as directory:
            tarball = Path(directory) / "package.tgz"
            tarball.write_bytes(b"different")
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "SHA-512 differs"
            ):
                install_latest_rcl.verify_tarball(tarball, expected)

    def test_rejects_a_symlinked_tarball(self):
        expected = install_latest_rcl.parse_metadata(metadata())
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target.tgz"
            target.write_bytes(b"review council")
            tarball = Path(directory) / "package.tgz"
            tarball.symlink_to(target)
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "owned, non-writable regular file"
            ):
                install_latest_rcl.verify_tarball(tarball, expected)


class InstallLatestRclTest(unittest.TestCase):
    def test_command_failures_include_the_captured_diagnostic(self):
        def failing_runner(command, **_options):
            raise subprocess.CalledProcessError(
                1, command, output="", stderr="registry unavailable"
            )

        with self.assertRaisesRegex(
            install_latest_rcl.InstallError, "registry unavailable"
        ):
            install_latest_rcl.run_command(failing_runner, ("npm", "view"))

    def test_installs_one_verified_release_from_one_metadata_tuple(self):
        payload = metadata()
        runner = FakeRunner([payload, payload, payload])

        with self.runtime_directory() as binaries:
            version = install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(version, "2.1.3")
        self.assertEqual(
            [command[2] for command in runner.calls],
            ["view", "list", "list", "pack", "view", "install", "view", "list"],
        )
        for command in runner.calls:
            self.assertIn(
                "--registry=https://registry.npmjs.org/", command
            )
            if command[2] in {"list", "install", "uninstall"}:
                self.assertTrue(any(value.startswith("--prefix=") for value in command))

    def test_installs_with_array_metadata_and_package_keyed_pack_output(self):
        payload = json.dumps([json.loads(metadata())])
        runner = FakeRunner([payload] * 3, pack_as_object=True)
        with self.runtime_directory() as binaries, self.runtime_directory() as target:
            npm_bin, node_bin, runtime_prefix = self.runtime(Path(binaries))
            version = install_latest_rcl.install_latest_rcl(
                npm_bin, node_bin, target, runtime_prefix=runtime_prefix, runner=runner
            )

        self.assertEqual(version, "2.1.3")
        self.assertEqual(runner.installed_version, "2.1.3")

    def test_installs_into_a_separately_approved_prefix(self):
        runner = FakeRunner([metadata()] * 3)
        with self.runtime_directory() as binaries, self.runtime_directory() as target:
            npm_bin, node_bin, runtime_prefix = self.runtime(Path(binaries))
            version = install_latest_rcl.install_latest_rcl(
                npm_bin, node_bin, target, runtime_prefix=runtime_prefix, runner=runner
            )

        self.assertEqual(version, "2.1.3")
        for command in runner.calls:
            self.assertEqual(command[:2], (node_bin, npm_bin))
            if command[2] in {"list", "install"}:
                self.assertIn(f"--prefix={target}", command)
                self.assertNotIn(f"--prefix={runtime_prefix}", command)
            if command[2] in {"pack", "install"}:
                self.assertIn("--ignore-scripts", command)

    def test_split_prefix_requires_explicit_runtime_approval(self):
        runner = FakeRunner([])
        with self.runtime_directory() as binaries, self.runtime_directory() as target:
            npm_bin, node_bin, _prefix = self.runtime(Path(binaries))
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "outside the runtime prefix"
            ):
                install_latest_rcl.install_latest_rcl(
                    npm_bin, node_bin, target, runner=runner
                )
        self.assertEqual(runner.calls, [])

    def test_split_prefix_cleanup_uses_the_install_target(self):
        runner = FakeRunner([metadata()] * 3, list_version_override="9.9.9")
        with self.runtime_directory() as binaries, self.runtime_directory() as target:
            npm_bin, node_bin, runtime_prefix = self.runtime(Path(binaries))
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "differs from latest metadata"
            ):
                install_latest_rcl.install_latest_rcl(
                    npm_bin, node_bin, target,
                    runtime_prefix=runtime_prefix, runner=runner,
                )
        cleanup = [call for call in runner.calls if call[2] == "uninstall"]
        self.assertEqual(len(cleanup), 1)
        self.assertIn(f"--prefix={target}", cleanup[0])
        self.assertIn("--ignore-scripts", cleanup[0])
        self.assertNotIn(f"--prefix={runtime_prefix}", cleanup[0])

    def test_split_prefix_rejects_unsafe_paths_before_running_npm(self):
        for unsafe in ("runtime", "target", "npm", "node", "ancestor"):
            with self.subTest(unsafe=unsafe), self.runtime_directory() as root:
                directory = Path(root)
                runtime = directory / "runtime"
                target = directory / "target"
                runtime.mkdir()
                target.mkdir()
                npm_bin, node_bin, runtime_prefix = self.runtime(runtime)
                paths = {
                    "runtime": runtime, "target": target,
                    "npm": Path(npm_bin), "node": Path(node_bin),
                    "ancestor": directory,
                }
                paths[unsafe].chmod(0o777)
                runner = FakeRunner([])
                label = {
                    "runtime": "runtime prefix", "target": "installation prefix",
                    "ancestor": "installation prefix", "npm": "npm path", "node": "node path",
                }[unsafe]
                with self.assertRaisesRegex(
                    install_latest_rcl.InstallError, f"{label} has (an )?unsafe"
                ):
                    install_latest_rcl.install_latest_rcl(
                        npm_bin, node_bin, str(target),
                        runtime_prefix=runtime_prefix, runner=runner,
                    )
                self.assertEqual(runner.calls, [])

    def test_split_prefix_rejects_executables_outside_the_runtime(self):
        for executable in ("npm", "node"):
            with self.subTest(executable=executable), self.runtime_directory() as root:
                runtime = Path(root) / "runtime"
                target = Path(root) / "target"
                runtime.mkdir()
                target.mkdir()
                npm_bin, node_bin, runtime_prefix = self.runtime(runtime)
                escaped = target / executable
                escaped.write_bytes((runtime / executable).read_bytes())
                escaped.chmod(0o755)
                (runtime / executable).unlink()
                (runtime / executable).symlink_to(escaped)
                runner = FakeRunner([])
                with self.assertRaisesRegex(
                    install_latest_rcl.InstallError, "outside the runtime prefix"
                ):
                    install_latest_rcl.install_latest_rcl(
                        npm_bin, node_bin, str(target),
                        runtime_prefix=runtime_prefix, runner=runner,
                    )
                self.assertEqual(runner.calls, [])

    def test_split_prefix_rejects_unexpected_ownership(self):
        for location, field in (
            ("runtime", stat.ST_UID), ("target", stat.ST_UID),
            ("node", stat.ST_UID), ("node", stat.ST_GID),
        ):
            with self.subTest(location=location, field=field), self.runtime_directory() as root:
                runtime = Path(root) / "runtime"
                target = Path(root) / "target"
                runtime.mkdir()
                target.mkdir()
                npm_bin, node_bin, runtime_prefix = self.runtime(runtime)
                unsafe = {"runtime": runtime, "target": target, "node": Path(node_bin)}[location]
                original_stat = Path.stat

                def unexpected_owner(path, *args, **kwargs):
                    result = original_stat(path, *args, **kwargs)
                    if path == unsafe:
                        fields = list(result)
                        fields[field] += 1
                        return os.stat_result(fields)
                    return result

                runner = FakeRunner([])
                with mock.patch.object(Path, "stat", unexpected_owner), self.assertRaisesRegex(
                    install_latest_rcl.InstallError, "unsafe ownership or permissions"
                ):
                    install_latest_rcl.install_latest_rcl(
                        npm_bin, node_bin, str(target),
                        runtime_prefix=runtime_prefix, runner=runner,
                    )
                self.assertEqual(runner.calls, [])

    def test_split_prefix_rejects_an_empty_runtime_prefix(self):
        runner = FakeRunner([])
        with self.runtime_directory() as binaries:
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "runtime prefix must be absolute"
            ):
                install_latest_rcl.install_latest_rcl(
                    *self.runtime(Path(binaries)), runtime_prefix="", runner=runner
                )
        self.assertEqual(runner.calls, [])

    def test_runtime_prefix_rejects_a_group_writable_ancestor_with_a_different_group(self):
        with self.runtime_directory() as root, self.runtime_directory() as target:
            store = Path(root) / "store"
            runtime = store / "nodejs"
            runtime.mkdir(parents=True)
            npm_bin, node_bin, runtime_prefix = self.runtime(runtime)
            original_stat = Path.stat

            def shared_store(path, *args, **kwargs):
                result = original_stat(path, *args, **kwargs)
                if path == store:
                    fields = list(result)
                    fields[stat.ST_MODE] = stat.S_IFDIR | 0o1775
                    fields[stat.ST_GID] += 1
                    return os.stat_result(fields)
                return result

            runner = FakeRunner([])
            with mock.patch.object(Path, "stat", shared_store), self.assertRaisesRegex(
                install_latest_rcl.InstallError, "runtime prefix has an unsafe ancestor"
            ):
                install_latest_rcl.install_latest_rcl(
                    npm_bin, node_bin, target,
                    runtime_prefix=runtime_prefix, runner=runner,
                )
            self.assertEqual(runner.calls, [])

    def test_split_prefix_rejects_an_unapproved_npm_shebang(self):
        runner = FakeRunner([])
        with self.runtime_directory() as binaries, self.runtime_directory() as target:
            npm_bin, node_bin, runtime_prefix = self.runtime(Path(binaries))
            Path(npm_bin).write_text("#!/bin/sh\n")
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "expected Node shebang"
            ):
                install_latest_rcl.install_latest_rcl(
                    npm_bin, node_bin, target,
                    runtime_prefix=runtime_prefix, runner=runner,
                )
        self.assertEqual(runner.calls, [])

    def test_cli_passes_the_explicit_runtime_prefix(self):
        arguments = [
            "install_latest_rcl.py", "--npm-bin", "/runtime/npm",
            "--node-bin", "/runtime/node", "--approved-prefix", "/target",
            "--runtime-prefix", "/runtime",
        ]
        with mock.patch.object(sys, "argv", arguments), mock.patch.object(
            install_latest_rcl, "install_latest_rcl", return_value="2.1.3"
        ) as install, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ):
            self.assertEqual(install_latest_rcl.main(), 0)
        install.assert_called_once_with(
            "/runtime/npm", "/runtime/node", "/target", runtime_prefix="/runtime"
        )

    def test_cli_leaves_runtime_prefix_unspecified_by_default(self):
        arguments = [
            "install_latest_rcl.py", "--npm-bin", "/runtime/npm",
            "--node-bin", "/runtime/node", "--approved-prefix", "/runtime",
        ]
        with mock.patch.object(sys, "argv", arguments), mock.patch.object(
            install_latest_rcl, "install_latest_rcl", return_value="2.1.3"
        ) as install, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(install_latest_rcl.main(), 0)
        install.assert_called_once_with(
            "/runtime/npm", "/runtime/node", "/runtime", runtime_prefix=None
        )

    def test_reinstalls_a_verified_artifact_when_latest_is_already_present(self):
        payload = metadata()
        runner = FakeRunner([payload, payload, payload])
        runner.installed_version = "2.1.3"

        with self.runtime_directory() as binaries:
            version = install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(version, "2.1.3")
        self.assertEqual(
            [call[2] for call in runner.calls],
            ["view", "list", "list", "pack", "view", "install", "view", "list"],
        )

    def test_removes_a_legacy_review_council_install_before_installing(self):
        payload = metadata()
        runner = FakeRunner([payload, payload, payload])
        runner.legacy_version = "4.4.19"
        stderr = io.StringIO()

        with self.runtime_directory() as binaries, contextlib.redirect_stderr(stderr):
            version = install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(version, "2.1.3")
        self.assertIsNone(runner.legacy_version)
        self.assertEqual(runner.installed_version, "2.1.3")
        self.assertEqual(
            [call[2] for call in runner.calls],
            ["view", "list", "list", "pack", "view", "uninstall", "install", "view", "list"],
        )
        uninstall = next(call for call in runner.calls if call[2] == "uninstall")
        self.assertEqual(uninstall[3:5], ("-g", "review-council"))
        self.assertIn("--ignore-scripts", uninstall)
        self.assertTrue(any(value.startswith("--prefix=") for value in uninstall))
        self.assertIn("Removing review-council 4.4.19", stderr.getvalue())

    def test_keeps_the_legacy_install_when_the_new_artifact_fails_verification(self):
        payload = metadata()
        runner = FakeRunner(
            [payload, payload],
            package_bytes=b"tampered",
            reported_bytes=b"review council",
        )
        runner.legacy_version = "4.4.19"

        with self.runtime_directory() as binaries, self.assertRaisesRegex(
            install_latest_rcl.InstallError, "SHA-512 differs"
        ):
            install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(runner.legacy_version, "4.4.19")
        self.assertNotIn("uninstall", [call[2] for call in runner.calls])
        self.assertNotIn("install", [call[2] for call in runner.calls])

    def test_strips_ambient_node_npm_and_unrelated_secrets(self):
        payload = metadata()
        runner = FakeRunner([payload, payload, payload])

        with mock.patch.dict(
            os.environ,
            {
                "NODE_OPTIONS": "--require=/tmp/untrusted.js",
                "NPM_CONFIG_REGISTRY": "https://example.invalid/",
                "GITHUB_TOKEN": "secret",
            },
        ), self.runtime_directory() as binaries:
            install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        for options in runner.options:
            environment = options["env"]
            self.assertNotIn("NODE_OPTIONS", environment)
            self.assertNotIn("NPM_CONFIG_REGISTRY", environment)
            self.assertNotIn("GITHUB_TOKEN", environment)

    def test_installs_a_release_with_build_metadata(self):
        payload = metadata(
            version="3.0.0+build.7",
            tarball=(
                "https://registry.npmjs.org/@allocator-one/rcl/-/"
                "rcl-3.0.0%2Bbuild.7.tgz"
            ),
        )
        runner = FakeRunner([payload, payload, payload])

        with self.runtime_directory() as binaries:
            version = install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(version, "3.0.0+build.7")

    def test_rejects_mismatched_pack_bytes_and_extra_files(self):
        for runner, message in (
            (
                FakeRunner(
                    [metadata()],
                    package_bytes=b"tampered",
                    reported_bytes=b"review council",
                ),
                "SHA-512 differs",
            ),
            (FakeRunner([metadata()], extra_pack_file=True), "unexpected files"),
        ):
            with self.subTest(message=message), self.runtime_directory() as binaries:
                with self.assertRaisesRegex(install_latest_rcl.InstallError, message):
                    install_latest_rcl.install_latest_rcl(
                        *self.runtime(Path(binaries)), runner=runner
                    )

    def test_rejects_missing_relative_and_worktree_npm_paths(self):
        with self.runtime_directory() as binaries:
            _npm_bin, node_bin, approved_prefix = self.runtime(Path(binaries))
            for npm_path, message in (
                ("npm", "must be absolute"),
                ("/definitely/missing/npm", "does not exist"),
                (str(Path(__file__).resolve()), "inside the worktree"),
            ):
                with self.subTest(npm_path=npm_path), self.assertRaisesRegex(
                    install_latest_rcl.InstallError, message
                ):
                    install_latest_rcl.install_latest_rcl(
                        npm_path, node_bin, approved_prefix, runner=FakeRunner([])
                    )

    def test_rejects_a_non_root_owned_temp_root(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(
            install_latest_rcl.InstallError, "root-owned sticky directory"
        ):
            install_latest_rcl.validate_temp_root(Path(directory))

    def test_rejects_an_installed_version_mismatch(self):
        payload = metadata()
        runner = FakeRunner(
            [payload, payload, payload], list_version_override="9.9.9"
        )

        with self.runtime_directory() as binaries, self.assertRaisesRegex(
            install_latest_rcl.InstallError, "differs from latest metadata"
        ):
            install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertIn("uninstall", [call[2] for call in runner.calls])

    def test_rejects_a_broken_existing_global_installation(self):
        runner = FakeRunner([metadata()], list_returncode_override=1)
        runner.installed_version = "2.1.3"

        with self.runtime_directory() as binaries, self.assertRaisesRegex(
            install_latest_rcl.InstallError, "broken global RCL installation"
        ):
            install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

    def test_removes_an_install_if_the_source_changes_during_install(self):
        payload = metadata()
        runner = FakeRunner(
            [payload, payload], mutate_after_install=True
        )

        with self.runtime_directory() as binaries, self.assertRaisesRegex(
            install_latest_rcl.InstallError, "SHA-512 differs"
        ):
            install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertIsNone(runner.installed_version)
        self.assertIn("uninstall", [call[2] for call in runner.calls])

    def test_pack_uses_a_private_umask(self):
        payload = metadata()
        runner = FakeRunner([payload, payload, payload])
        previous = os.umask(0o002)
        try:
            with self.runtime_directory() as binaries:
                version = install_latest_rcl.install_latest_rcl(
                    *self.runtime(Path(binaries)), runner=runner
                )
        finally:
            os.umask(previous)

        self.assertEqual(version, "2.1.3")

    def test_rejects_an_unsafe_node_executable(self):
        with self.runtime_directory() as binaries:
            npm_bin, node_bin, approved_prefix = self.runtime(Path(binaries))
            Path(node_bin).chmod(0o777)
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "unsafe ownership or permissions"
            ):
                install_latest_rcl.install_latest_rcl(
                    npm_bin, node_bin, approved_prefix, runner=FakeRunner([])
                )

    def test_accepts_an_npm_shebang_bound_to_the_exact_node_binary(self):
        with self.runtime_directory() as binaries:
            npm_bin, node_bin, approved_prefix = self.runtime(Path(binaries))
            Path(npm_bin).write_text(f"#!{Path(node_bin).resolve()}\n")

            validated = install_latest_rcl.validate_npm_runtime(
                npm_bin, node_bin, approved_prefix
            )

        self.assertEqual(validated[1], str(Path(node_bin).resolve()))

    def test_rejects_an_unapproved_npm_shebang(self):
        with self.runtime_directory() as binaries:
            npm_bin, node_bin, approved_prefix = self.runtime(Path(binaries))
            Path(npm_bin).write_text("#!/bin/sh\n")

            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "expected Node shebang"
            ):
                install_latest_rcl.validate_npm_runtime(
                    npm_bin, node_bin, approved_prefix
                )

    def test_retries_when_latest_metadata_changes_before_install(self):
        previous = metadata(version="2.1.3")
        current = metadata(version="2.1.4")
        runner = FakeRunner([previous, current, current, current, current])

        with self.runtime_directory() as binaries, contextlib.redirect_stderr(
            io.StringIO()
        ):
            version = install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(version, "2.1.4")
        install_calls = [call for call in runner.calls if call[2] == "install"]
        self.assertEqual(len(install_calls), 1)
        self.assertTrue(
            any("allocator-one-rcl-2.1.4.tgz" in value for value in install_calls[0])
        )

    def test_retries_when_latest_metadata_changes_after_install(self):
        previous = metadata(version="2.1.3")
        current = metadata(version="2.1.4")
        runner = FakeRunner([previous, previous, current, current, current, current])

        with self.runtime_directory() as binaries, contextlib.redirect_stderr(
            io.StringIO()
        ):
            version = install_latest_rcl.install_latest_rcl(
                *self.runtime(Path(binaries)), runner=runner
            )

        self.assertEqual(version, "2.1.4")
        install_calls = [call for call in runner.calls if call[2] == "install"]
        self.assertEqual(len(install_calls), 2)
        self.assertEqual(
            len([call for call in runner.calls if call[2] == "uninstall"]), 1
        )

    def test_fails_after_three_consecutive_publication_races(self):
        payloads = []
        for patch in range(6):
            payloads.append(metadata(version=f"2.1.{patch}"))
        runner = FakeRunner(payloads)

        with self.runtime_directory() as binaries, contextlib.redirect_stderr(
            io.StringIO()
        ):
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError, "3 consecutive attempts"
            ):
                install_latest_rcl.install_latest_rcl(
                    *self.runtime(Path(binaries)), runner=runner
                )

        self.assertFalse(any(call[2] == "install" for call in runner.calls))

    def test_final_race_error_removes_the_stale_global_install(self):
        versions = [metadata(version=f"2.1.{patch}") for patch in range(1, 5)]
        runner = FakeRunner(
            [
                versions[0],
                versions[0],
                versions[1],
                versions[1],
                versions[1],
                versions[2],
                versions[2],
                versions[2],
                versions[3],
            ]
        )

        with self.runtime_directory() as binaries, contextlib.redirect_stderr(
            io.StringIO()
        ):
            with self.assertRaisesRegex(
                install_latest_rcl.InstallError,
                "3 consecutive attempts",
            ):
                install_latest_rcl.install_latest_rcl(
                    *self.runtime(Path(binaries)), runner=runner
                )

        self.assertIsNone(runner.installed_version)
        self.assertEqual(
            len([call for call in runner.calls if call[2] == "uninstall"]), 3
        )

    @staticmethod
    def runtime_directory():
        return tempfile.TemporaryDirectory(prefix=".rcl-test-", dir=Path.home())

    @staticmethod
    def runtime(directory):
        npm = directory / "npm"
        npm.write_text("#!/usr/bin/env node\n")
        npm.chmod(0o755)
        node = directory / "node"
        node.touch()
        node.chmod(0o755)
        return str(npm), str(node), str(directory)


if __name__ == "__main__":
    unittest.main()
