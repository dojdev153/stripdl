import unittest

import strip
from click.testing import CliRunner
from strip.cli import cli


class VersionTests(unittest.TestCase):
    def test_cli_version_matches_package_version(self):
        result = CliRunner().invoke(cli, ["--version"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn(strip.__version__, result.output)

    def test_runtime_version_is_target_patch_release(self):
        self.assertEqual(strip.__version__, "0.3.2")
