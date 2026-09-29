import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"


class ReleaseWorkflowTests(unittest.TestCase):
    def test_release_workflow_contract(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('tags: ["v*.*.*"]', workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("contents: write", workflow)
        self.assertIn("verify_release_tag.py", workflow)
        self.assertIn("package_cli.py", workflow)
        self.assertIn("npx electron-builder", workflow)
        self.assertIn("actions/upload-artifact@v4", workflow)
        self.assertIn("SHA256SUMS.txt", workflow)
        self.assertIn("create_checksums.py", workflow)
        self.assertIn("find release -type f -print0", workflow)
        self.assertNotIn("sha256sum * > SHA256SUMS.txt", workflow)
        self.assertIn("gh release create", workflow)
        publish_job = workflow.split("\n  publish:\n", 1)[1]
        checkout = "    steps:\n      - name: Check out repository\n        uses: actions/checkout@v4"
        self.assertIn(checkout, publish_job)
        self.assertLess(
            publish_job.index("Check out repository"),
            publish_job.index("Download all artifacts"),
        )

    def test_artifact_upload_excludes_electron_unpack_directories(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        for extension in ("*.dmg", "*.exe", "*.AppImage", "*.deb"):
            self.assertIn(f"desktop/release/{extension}", workflow)
        self.assertNotIn("desktop/release/*\n", workflow)
        for label in (
            "windows-latest",
            "windows-11-arm",
            "macos-15-intel",
            "macos-latest",
            "ubuntu-24.04",
            "ubuntu-24.04-arm",
        ):
            self.assertIn(label, workflow)
        self.assertNotIn("strip-data", workflow)

    def test_release_version_argument_is_shell_independent(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('--version "${{ needs.validate.outputs.version }}"', workflow)
        self.assertNotIn('--version "$RELEASE_VERSION"', workflow)

    def test_linux_arm64_uses_native_cli_and_x64_packager(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("build-linux-arm64-cli:", workflow)
        self.assertIn("needs: [validate, build-linux-arm64-cli]", workflow)
        self.assertIn("- name: Linux arm64\n            runner: ubuntu-24.04\n", workflow)
        self.assertIn("runs-on: ubuntu-24.04-arm", workflow)
        self.assertIn("actions/download-artifact@v4", workflow)
        self.assertIn("name: linux-arm64-cli-native", workflow)
        self.assertIn("desktop/resources/strip-cli/stripdl", workflow)
        self.assertIn("chmod +x desktop/resources/strip-cli/stripdl", workflow)
        self.assertIn("matrix.platform != 'linux' || matrix.arch != 'arm64'", workflow)
        self.assertIn("matrix.platform == 'linux' && matrix.arch == 'arm64'", workflow)

    def test_electron_builder_metadata_paths_and_linux_package_metadata(self):
        package = json.loads((ROOT / "desktop" / "package.json").read_text(encoding="utf-8"))
        build = package["build"]
        background = ROOT / "desktop" / build["dmg"]["background"]

        self.assertTrue(background.is_file(), background)
        self.assertIsInstance(package["author"], dict)
        self.assertTrue(package["author"].get("email"))
        self.assertTrue(package.get("homepage"))
        self.assertTrue(build["linux"].get("maintainer"))

    def test_tag_validator_accepts_matching_tag_and_rejects_mismatch(self):
        script = ROOT / ".github" / "scripts" / "verify_release_tag.py"
        matching = subprocess.run(
            [sys.executable, str(script), "--tag", "v0.4.0"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        mismatch = subprocess.run(
            [sys.executable, str(script), "--tag", "v0.3.9"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(matching.returncode, 0, matching.stdout + matching.stderr)
        self.assertNotEqual(mismatch.returncode, 0)

    def test_cli_packager_uses_platform_and_architecture_in_artifact_name(self):
        script = ROOT / ".github" / "scripts" / "package_cli.py"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "stripdl"
            source.write_bytes(b"standalone cli")
            output = Path(directory) / "out"
            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--version",
                    "0.4.0",
                    "--platform",
                    "linux",
                    "--arch",
                    "arm64",
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONUTF8": "1"},
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((output / "stripdl-0.4.0-linux-arm64.tar.gz").is_file())

    def test_checksum_script_handles_nested_release_artifacts(self):
        script = ROOT / ".github" / "scripts" / "create_checksums.py"
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / "release"
            (release / "desktop").mkdir(parents=True)
            (release / "release-cli").mkdir()
            (release / "desktop" / "strip-win.exe").write_bytes(b"windows")
            (release / "release-cli" / "stripdl-linux.tar.gz").write_bytes(b"linux")
            output = release / "SHA256SUMS.txt"

            result = subprocess.run(
                [sys.executable, str(script), "--root", str(release), "--output", str(output)],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            checksums = output.read_text(encoding="utf-8")
            self.assertIn("desktop/strip-win.exe", checksums)
            self.assertIn("release-cli/stripdl-linux.tar.gz", checksums)
            self.assertNotIn("SHA256SUMS.txt", checksums)


if __name__ == "__main__":
    unittest.main()
