import ctypes
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass(frozen=True)
class WindowsAppEntry:
    alias: str
    display_name: str
    candidates: List[str]


DEFAULT_WINDOWS_APPS: Dict[str, WindowsAppEntry] = {
    "chrome": WindowsAppEntry(
        alias="chrome",
        display_name="Google Chrome",
        candidates=[
            "chrome.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ],
    ),
    "vscode": WindowsAppEntry(
        alias="vscode",
        display_name="Visual Studio Code",
        candidates=[
            "code.cmd",
            "code.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"),
            r"C:\Program Files\Microsoft VS Code\Code.exe",
        ],
    ),
    "edge": WindowsAppEntry(
        alias="edge",
        display_name="Microsoft Edge",
        candidates=[
            "msedge.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ],
    ),
    "notepad": WindowsAppEntry(
        alias="notepad",
        display_name="Notepad",
        candidates=["notepad.exe"],
    ),
    "calculator": WindowsAppEntry(
        alias="calculator",
        display_name="Calculator",
        candidates=["calc.exe"],
    ),
    "explorer": WindowsAppEntry(
        alias="explorer",
        display_name="File Explorer",
        candidates=["explorer.exe"],
    ),
    "terminal": WindowsAppEntry(
        alias="terminal",
        display_name="Windows Terminal",
        candidates=["wt.exe", "powershell.exe"],
    ),
    "spotify": WindowsAppEntry(
        alias="spotify",
        display_name="Spotify",
        candidates=[
            "spotify.exe",
            os.path.expandvars(r"%APPDATA%\Spotify\Spotify.exe"),
        ],
    ),
}


def resolve_executable(entry: WindowsAppEntry) -> Optional[str]:
    for candidate in entry.candidates:
        if os.path.isabs(candidate) and os.path.exists(candidate):
            return candidate
        which_path = shutil.which(candidate)
        if which_path:
            return which_path
    return None


def list_installed_apps(
    allowlist: Dict[str, WindowsAppEntry] = DEFAULT_WINDOWS_APPS,
) -> List[Dict[str, str]]:
    installed: List[Dict[str, str]] = []
    for entry in allowlist.values():
        exe = resolve_executable(entry)
        if exe:
            installed.append(
                {
                    "alias": entry.alias,
                    "identifier": exe,
                    "displayName": entry.display_name,
                }
            )
    return installed


def launch_allowlisted_app(
    alias: str,
    allowlist: Dict[str, WindowsAppEntry] = DEFAULT_WINDOWS_APPS,
) -> tuple[bool, Optional[str], str]:
    key = (alias or "").strip().lower()
    entry = allowlist.get(key)
    if not entry:
        return (
            False,
            "APP_NOT_INSTALLED",
            f"Application '{alias}' is not in the Windows agent allowlist.",
        )

    exe = resolve_executable(entry)
    if not exe:
        return (
            False,
            "APP_NOT_INSTALLED",
            f"{entry.display_name} is not installed on this Windows device.",
        )

    if sys.platform != "win32":
        return (
            False,
            "UNSUPPORTED_OPERATION",
            f"Windows app launching is only supported on win32 (current: {sys.platform}).",
        )

    # Always spawn without shell=True to prevent command injection
    subprocess.Popen([exe], shell=False)
    return True, None, f"Opening {entry.display_name}."


def lock_windows_workstation() -> tuple[bool, Optional[str], str]:
    if sys.platform != "win32":
        return (
            False,
            "UNSUPPORTED_OPERATION",
            "LockWorkStation is only supported on Windows.",
        )
    ok = bool(ctypes.windll.user32.LockWorkStation())
    if not ok:
        return False, "EXECUTION_FAILED", "Windows LockWorkStation() returned false."
    return True, None, "Your Windows laptop has been locked."


def request_windows_unlock() -> tuple[bool, Optional[str], str]:
    # Never bypass Winlogon / Windows Credential Guard
    return (
        True,
        None,
        "Unlock requested. Windows requires interactive sign-in via Windows Hello, PIN, or password on your laptop.",
    )
