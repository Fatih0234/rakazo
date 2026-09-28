"""Offline regressions for the focus-or-launch wrapper and its control argv."""
import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


def load_module(name, filename):
    loader = importlib.machinery.SourceFileLoader(name, str(Path(__file__).with_name(filename)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


helper = load_module("focus_or_launch", "rakazo-focus-or-launch")
control = load_module("control", "control.py")

LISTING = """\
0x01800003  0 chromium.Chromium   box  Example page - Chromium
0x04000003  0 xterm.XTerm         box  Terminal
0x0400000f -1 N/A.N/A             box  dock
0x04400010  0
"""


class WmClassTest(unittest.TestCase):
    def test_known_launchers_have_fixed_classes(self):
        self.assertEqual(helper.wm_class("rakazo-browser"), "chromium")
        self.assertEqual(helper.wm_class("xterm"), "xterm")

    def test_other_launchers_match_their_binary_basename(self):
        self.assertEqual(helper.wm_class("/usr/bin/xterm"), "xterm")
        self.assertEqual(helper.wm_class("XTerm"), "xterm")


class MatchingWindowTest(unittest.TestCase):
    def test_matches_the_wm_class_field_not_id_host_or_title(self):
        self.assertEqual(helper.matching_window(LISTING, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window(LISTING, "chromium"), "0x01800003")
        self.assertEqual(helper.matching_window(LISTING, "Terminal"), "")

    def test_matching_is_case_insensitive(self):
        listing = LISTING.replace("xterm.XTerm", "XTerm.XTerm")
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")

    def test_first_match_wins_and_malformed_rows_are_skipped(self):
        listing = LISTING + "0x05000000  0 xterm.XTerm         box  second\n"
        self.assertEqual(helper.matching_window(listing, "xterm"), "0x04000003")
        self.assertEqual(helper.matching_window("garbage\n\n", "xterm"), "")
        self.assertEqual(helper.matching_window("", "xterm"), "")


class MainTest(unittest.TestCase):
    def run_wrapper(self, argv, listing=LISTING, launch_code=0):
        calls = []

        def fake_run(run_argv, **_kwargs):
            if run_argv[0] == "wmctrl":
                return subprocess.CompletedProcess(run_argv, 0, listing, "")
            return subprocess.CompletedProcess(run_argv, launch_code, "", "")

        # exec replaces the process; the fake stops the call instead.
        def fake_execvp(*call):
            calls.append(call)
            raise SystemExit(0)

        with patch.object(helper.subprocess, "run", side_effect=fake_run) as run, patch.object(
            helper.os, "execvp", side_effect=fake_execvp
        ):
            try:
                helper.main(argv)
            except SystemExit as error:
                if error.code:
                    calls.append(("exit", error.code))
        return run, calls

    def test_activates_a_matching_window_without_spawning(self):
        run, calls = self.run_wrapper(["xterm"])
        self.assertEqual(calls, [("wmctrl", ["wmctrl", "-ia", "0x04000003"])])
        self.assertEqual(run.call_count, 1)

    def test_spawns_the_launcher_when_no_window_matches(self):
        _, calls = self.run_wrapper(["xterm"], listing="")
        self.assertEqual(calls, [("xterm", ["xterm"])])

    def test_missing_wmctrl_still_spawns(self):
        with patch.object(helper.subprocess, "run", side_effect=OSError), patch.object(
            helper.os, "execvp", side_effect=SystemExit(0)
        ) as execvp:
            with self.assertRaises(SystemExit):
                helper.main(["xterm"])
        execvp.assert_called_once_with("xterm", ["xterm"])

    def test_arguments_reach_the_launcher_before_the_window_is_raised(self):
        run, calls = self.run_wrapper(["rakazo-browser", "https://example.test"])
        run.assert_any_call(["rakazo-browser", "https://example.test"])
        self.assertEqual(calls, [("wmctrl", ["wmctrl", "-ia", "0x01800003"])])

    def test_a_failing_launcher_does_not_raise_or_succeed(self):
        run, calls = self.run_wrapper(["xterm", "bad-flag"], launch_code=1)
        run.assert_any_call(["xterm", "bad-flag"])
        self.assertEqual(calls, [("exit", 1)])

    def test_usage_error_without_a_launcher(self):
        with self.assertRaises(SystemExit):
            helper.main([])


PROFILE = "/home/rakazo/.browser-profiles/chromium-bot-" + "a" * 32


class ControlArgvTest(unittest.TestCase):
    def test_accepts_wrapped_known_launchers(self):
        for argv in (
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser", "https://example.test"],
            [
                "env",
                "DISPLAY=:1",
                f"RAKAZO_BROWSER_PROFILE={PROFILE}",
                "rakazo-focus-or-launch",
                "rakazo-browser",
                "https://example.test",
            ],
        ):
            with self.subTest(argv=argv):
                self.assertTrue(control.allowed_control_argv(argv, ":1"))
                self.assertTrue(control.is_long_lived_control(argv))

    def test_rejects_launchers_outside_the_allowlist(self):
        for inner in ("sh", "wmctrl", "rakazo-focus-or-launch", "/usr/bin/xterm"):
            argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", inner]
            with self.subTest(inner=inner):
                self.assertFalse(control.allowed_control_argv(argv, ":1"))

    def test_rejects_bad_arity_and_a_browser_profile_on_other_launchers(self):
        for argv in (
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm", "one", "two"],
            ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm", "-e", "sh"],
            [
                "env",
                "DISPLAY=:1",
                f"RAKAZO_BROWSER_PROFILE={PROFILE}",
                "rakazo-focus-or-launch",
                "xterm",
            ],
            ["env", "DISPLAY=:8", "rakazo-focus-or-launch", "xterm"],
        ):
            with self.subTest(argv=argv):
                self.assertFalse(control.allowed_control_argv(argv, ":1"))

    def test_wrapped_browser_keeps_the_browser_spawn_poll(self):
        argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "rakazo-browser"]
        self.assertEqual(control.launch_spawn_poll_sec(argv), control.BROWSER_OPEN_POLL_SEC)
        argv = ["env", "DISPLAY=:1", "rakazo-focus-or-launch", "xterm"]
        self.assertEqual(control.launch_spawn_poll_sec(argv), control.LAUNCH_SPAWN_POLL_SEC)


if __name__ == "__main__":
    unittest.main()
