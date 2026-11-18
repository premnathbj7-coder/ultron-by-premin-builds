import sys
from unittest.mock import patch

from allowlist import (
    DEFAULT_WINDOWS_APPS,
    launch_allowlisted_app,
    request_windows_unlock,
)
from main import execute_hub_command


def test_disallows_unlisted_applications():
    ok, err_code, msg = launch_allowlisted_app("rm -rf / && calc")
    assert ok is False
    assert err_code == "APP_NOT_INSTALLED"
    assert "not in the Windows agent allowlist" in msg


def test_unlock_never_bypasses_auth():
    ok, err_code, msg = request_windows_unlock()
    assert ok is True
    assert err_code is None
    assert "interactive sign-in" in msg


def test_ping_command_returns_telemetry():
    with patch("main.read_battery_telemetry", return_value={"batteryPercent": 78, "isCharging": True}):
        res = execute_hub_command({"commandId": "cmd-1", "action": "PING"})
    assert res["success"] is True
    assert res["batteryPercent"] == 78
    assert res["isCharging"] is True


def test_launch_on_win32_uses_shell_false():
    with (
        patch.object(sys, "platform", "win32"),
        patch("allowlist.resolve_executable", return_value=r"C:\Program Files\VSCode\Code.exe"),
        patch("allowlist.subprocess.Popen") as popen_mock,
    ):
        ok, err_code, msg = launch_allowlisted_app("vscode", DEFAULT_WINDOWS_APPS)
    assert ok is True
    assert err_code is None
    assert "Visual Studio Code" in msg
    popen_mock.assert_called_once_with([r"C:\Program Files\VSCode\Code.exe"], shell=False)
