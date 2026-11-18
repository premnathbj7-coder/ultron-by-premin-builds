import argparse
import asyncio
import json
import os
import platform
import ssl
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import httpx
import psutil
import uvicorn
import websockets
from fastapi import FastAPI

from allowlist import (
    DEFAULT_WINDOWS_APPS,
    launch_allowlisted_app,
    list_installed_apps,
    lock_windows_workstation,
    request_windows_unlock,
)

CREDENTIALS_DIR = Path.home() / ".ultron-agent"
CREDENTIALS_FILE = CREDENTIALS_DIR / "credentials.json"

local_app = FastAPI(title="ULTRON Windows Local Agent", version="1.0.0")
agent_runtime_state: Dict[str, Any] = {
    "connected": False,
    "deviceName": None,
    "hubUrl": None,
    "lastCommand": None,
}


def read_battery_telemetry() -> Dict[str, Any]:
    try:
        batt = psutil.sensors_battery()
        if batt is None:
            return {"batteryPercent": None, "isCharging": None}
        return {
            "batteryPercent": int(round(batt.percent)),
            "isCharging": bool(batt.power_plugged),
        }
    except Exception:
        return {"batteryPercent": None, "isCharging": None}


@local_app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "platform": platform.platform(),
        "battery": read_battery_telemetry(),
        "agent": agent_runtime_state,
    }


@local_app.get("/apps")
def apps() -> Dict[str, Any]:
    return {"installedApps": list_installed_apps(DEFAULT_WINDOWS_APPS)}


def save_credentials(data: Dict[str, Any]) -> None:
    CREDENTIALS_DIR.mkdir(parents=True, exist_ok=True)
    CREDENTIALS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(CREDENTIALS_FILE, 0o600)
    except OSError:
        pass


def load_credentials() -> Optional[Dict[str, Any]]:
    if not CREDENTIALS_FILE.exists():
        return None
    try:
        return json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def pair_with_hub(
    hub_url: str,
    pairing_code: str,
    device_name: Optional[str],
    ca_cert: Optional[str],
) -> Dict[str, Any]:
    clean_hub = hub_url.rstrip("/")
    installed = list_installed_apps(DEFAULT_WINDOWS_APPS)
    payload = {
        "code": pairing_code.strip().upper(),
        "deviceName": device_name or platform.node() or "Windows Laptop",
        "osVersion": f"Windows {platform.release()}",
        "supportedActions": [
            "OPEN_APPLICATION",
            "LOCK_DEVICE",
            "UNLOCK_REQUEST",
            "CHECK_BATTERY",
            "PING",
        ],
        "installedApps": installed,
    }
    verify: Any = ca_cert if ca_cert else True
    with httpx.Client(timeout=15.0, verify=verify) as client:
        resp = client.post(f"{clean_hub}/api/ultron/pair/redeem", json=payload)
        resp.raise_for_status()
        data = resp.json()

    ws_scheme = "wss://" if clean_hub.startswith("https://") else "ws://"
    ws_host = clean_hub.replace("https://", "").replace("http://", "")
    creds = {
        "hubUrl": clean_hub,
        "wsUrl": f"{ws_scheme}{ws_host}/ws/agent",
        "deviceId": data["device"]["id"],
        "deviceName": data["device"]["name"],
        "token": data["token"],
        "tokenExpiresAt": data["tokenExpiresAt"],
    }
    save_credentials(creds)
    return creds


def execute_hub_command(cmd: Dict[str, Any]) -> Dict[str, Any]:
    command_id = cmd.get("commandId", "")
    action = cmd.get("action", "")
    application = cmd.get("application")
    telemetry = read_battery_telemetry()

    if action == "PING":
        return {
            "type": "agent:command_result",
            "commandId": command_id,
            "success": True,
            "message": f"{agent_runtime_state.get('deviceName', 'Windows Laptop')} is online.",
            **telemetry,
        }

    if action == "CHECK_BATTERY":
        pct = telemetry["batteryPercent"]
        if pct is None:
            msg = "Battery sensor unavailable on this Windows desktop."
        else:
            charging_text = " and charging" if telemetry["isCharging"] else ""
            msg = f"Windows laptop battery is {pct}%{charging_text}."
        return {
            "type": "agent:command_result",
            "commandId": command_id,
            "success": True,
            "message": msg,
            **telemetry,
        }

    if action == "OPEN_APPLICATION":
        ok, err_code, msg = launch_allowlisted_app(str(application or ""))
        return {
            "type": "agent:command_result",
            "commandId": command_id,
            "success": ok,
            **({"errorCode": err_code} if err_code else {}),
            "message": msg,
            **telemetry,
        }

    if action == "LOCK_DEVICE":
        ok, err_code, msg = lock_windows_workstation()
        return {
            "type": "agent:command_result",
            "commandId": command_id,
            "success": ok,
            **({"errorCode": err_code} if err_code else {}),
            "isLocked": True if ok else None,
            "message": msg,
            **telemetry,
        }

    if action == "UNLOCK_REQUEST":
        ok, err_code, msg = request_windows_unlock()
        return {
            "type": "agent:command_result",
            "commandId": command_id,
            "success": ok,
            **({"errorCode": err_code} if err_code else {}),
            "message": msg,
            **telemetry,
        }

    return {
        "type": "agent:command_result",
        "commandId": command_id,
        "success": False,
        "errorCode": "UNSUPPORTED_OPERATION",
        "message": f"Unsupported action: {action}",
        **telemetry,
    }


async def run_agent_loop(creds: Dict[str, Any], ca_cert: Optional[str]) -> None:
    ws_url = creds["wsUrl"]
    headers = {"Authorization": f"Bearer {creds['token']}"}
    ssl_ctx = ssl.create_default_context(cafile=ca_cert) if ws_url.startswith("wss://") else None

    agent_runtime_state["deviceName"] = creds["deviceName"]
    agent_runtime_state["hubUrl"] = creds["hubUrl"]

    backoff = 2
    while True:
        try:
            async with websockets.connect(
                ws_url,
                additional_headers=headers,
                ssl=ssl_ctx,
                ping_interval=20,
                ping_timeout=20,
            ) as ws:
                backoff = 2
                agent_runtime_state["connected"] = True
                telemetry = read_battery_telemetry()
                await ws.send(
                    json.dumps(
                        {
                            "type": "agent:hello",
                            "osVersion": f"Windows {platform.release()}",
                            "supportedActions": [
                                "OPEN_APPLICATION",
                                "LOCK_DEVICE",
                                "UNLOCK_REQUEST",
                                "CHECK_BATTERY",
                                "PING",
                            ],
                            "installedApps": list_installed_apps(DEFAULT_WINDOWS_APPS),
                            **telemetry,
                        }
                    )
                )

                async def heartbeat_task() -> None:
                    while True:
                        await asyncio.sleep(15)
                        await ws.send(
                            json.dumps(
                                {
                                    "type": "agent:heartbeat",
                                    **read_battery_telemetry(),
                                }
                            )
                        )

                hb = asyncio.create_task(heartbeat_task())
                try:
                    async for raw in ws:
                        msg = json.loads(raw)
                        if msg.get("type") == "hub:command":
                            agent_runtime_state["lastCommand"] = msg.get("action")
                            result = execute_hub_command(msg)
                            await ws.send(json.dumps(result))
                finally:
                    hb.cancel()
        except websockets.exceptions.InvalidStatus as exc:
            agent_runtime_state["connected"] = False
            if getattr(exc, "response", None) and exc.response.status_code == 401:
                print("[ULTRON] Token rejected/revoked. Re-pair using --pair <CODE>.")
                return
        except Exception as exc:
            agent_runtime_state["connected"] = False
            print(f"[ULTRON] WebSocket disconnected ({exc}); retrying in {backoff}s...")

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30)


def start_local_fastapi_thread() -> None:
    def _serve() -> None:
        uvicorn.run(local_app, host="127.0.0.1", port=8765, log_level="warning")

    t = threading.Thread(target=_serve, daemon=True)
    t.start()


def main() -> None:
    parser = argparse.ArgumentParser(description="ULTRON Windows Automation Agent")
    parser.add_argument("--pair", help="6-character pairing code from ULTRON Hub")
    parser.add_argument("--hub", default="http://localhost:3000", help="ULTRON Hub URL")
    parser.add_argument("--name", help="Friendly device name during pairing")
    parser.add_argument("--ca-cert", help="Optional TLS CA certificate file for wss://")
    args = parser.parse_args()

    if args.pair:
        creds = pair_with_hub(args.hub, args.pair, args.name, args.ca_cert)
        print(f"[ULTRON] Paired '{creds['deviceName']}' (ID: {creds['deviceId']}).")
    else:
        creds = load_credentials()
        if not creds:
            print("No saved ULTRON credentials. Run with --pair <CODE> --hub <URL>.")
            raise SystemExit(1)

    start_local_fastapi_thread()
    asyncio.run(run_agent_loop(creds, args.ca_cert))


if __name__ == "__main__":
    main()
