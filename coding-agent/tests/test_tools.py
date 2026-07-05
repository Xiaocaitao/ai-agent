import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tools


class CommandToolTests(unittest.TestCase):
    def test_runs_command_with_stdin(self):
        result = tools.run_command(
            [sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"],
            stdin="hello",
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["stdout"], "HELLO\n")
        self.assertEqual(result["data"]["exit_code"], 0)
        self.assertFalse(result["data"]["timed_out"])

    def test_reports_failure_and_stderr(self):
        result = tools.run_command(
            [sys.executable, "-c", "import sys; print('bad', file=sys.stderr); raise SystemExit(2)"]
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["data"]["exit_code"], 2)
        self.assertEqual(result["data"]["stderr"], "bad\n")

    def test_times_out(self):
        result = tools.run_command(
            [sys.executable, "-c", "import time; time.sleep(2)"], timeout=1
        )

        self.assertFalse(result["ok"])
        self.assertTrue(result["data"]["timed_out"])

    def test_truncates_output(self):
        result = tools.run_command(
            [sys.executable, "-c", "print('x' * 21000, end='')"]
        )

        self.assertEqual(len(result["data"]["stdout"]), 20000)
        self.assertTrue(result["data"]["truncated"])

    def test_does_not_interpret_shell_operators(self):
        result = tools.run_command(
            [sys.executable, "-c", "import sys; print(sys.argv[1:])", "&&", "echo", "bad"]
        )

        self.assertIn("'&&'", result["data"]["stdout"])
        self.assertNotIn("\nbad\n", result["data"]["stdout"])

    def test_rejects_delete_commands_and_outside_cwd(self):
        self.assertFalse(tools.run_command(["rm", "file.txt"])["ok"])
        self.assertFalse(tools.run_command([sys.executable, "--version"], cwd="../")["ok"])


class FileToolTests(unittest.TestCase):
    def test_configures_workspace_root(self):
        original = tools._common.WORKSPACE_ROOT
        try:
            with tempfile.TemporaryDirectory() as directory:
                tools.configure_workspace(directory)
                result = tools.write_file("created.txt", "content")

                self.assertTrue(result["ok"])
                self.assertTrue((Path(directory) / "created.txt").is_file())
        finally:
            tools._common.WORKSPACE_ROOT = original

    def test_writes_creates_parent_overwrites_and_reads_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(tools._common, "WORKSPACE_ROOT", root):
                first = tools.write_file("nested/data.txt", "one\ntwo\nthree\n")
                second = tools.write_file("nested/data.txt", "alpha\nbeta\ngamma\n")
                result = tools.read_file("nested/data.txt", start_line=2, max_lines=1)

            self.assertTrue(first["ok"])
            self.assertTrue(second["ok"])
            self.assertEqual(result["data"]["content"], "beta\n")
            self.assertEqual(result["data"]["start_line"], 2)
            self.assertEqual(result["data"]["end_line"], 2)
            self.assertTrue(result["data"]["truncated"])

    def test_rejects_outside_and_symlink_paths(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            (root / "link").symlink_to(Path(outside), target_is_directory=True)
            with patch.object(tools._common, "WORKSPACE_ROOT", root):
                outside_result = tools.read_file("../outside.txt")
                symlink_result = tools.write_file("link/data.txt", "secret")

            self.assertFalse(outside_result["ok"])
            self.assertFalse(symlink_result["ok"])

    def test_rejects_invalid_line_arguments(self):
        self.assertFalse(tools.read_file("tools.py", start_line=0)["ok"])
        self.assertFalse(tools.read_file("tools.py", max_lines=0)["ok"])


class SearchToolTests(unittest.TestCase):
    def test_searches_text_with_pattern_and_limits_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src").mkdir()
            (root / ".git").mkdir()
            (root / "src" / "main.py").write_text("needle\n" * 101, encoding="utf-8")
            (root / "src" / "skip.txt").write_text("needle\n", encoding="utf-8")
            (root / ".git" / "hidden.py").write_text("needle\n", encoding="utf-8")
            (root / "src" / "binary.py").write_bytes(b"needle\x00data")
            with patch.object(tools._common, "WORKSPACE_ROOT", root):
                result = tools.search_files("needle", path="src", pattern="*.py")

            self.assertTrue(result["ok"])
            self.assertEqual(len(result["data"]["matches"]), 100)
            self.assertTrue(result["data"]["truncated"])
            self.assertTrue(all(match["path"] == "src/main.py" for match in result["data"]["matches"]))


if __name__ == "__main__":
    unittest.main()
