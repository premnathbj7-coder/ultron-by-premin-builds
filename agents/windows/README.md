# ULTRON Windows Automation Agent

Python + FastAPI + WebSocket companion agent for controlling your Windows laptop from ULTRON Hub.

## Installation

```bash
cd agents/windows
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Pairing & Running

1. Open the ULTRON Web HUD (`http://localhost:3000`), click **DEVICES**, open **Pair Device**, select **Windows Automation Agent (Python)**, and generate a 6-character pairing code.
2. Run on your Windows laptop (replace `<CODE>` and `<HUB_URL>`):

```powershell
python main.py --pair <CODE> --hub http://<HUB_LAN_IP>:3000
```

Credentials are stored with user-only permissions in `%USERPROFILE%\.ultron-agent\credentials.json`. Subsequent starts only require:

```powershell
python main.py
```

A local loopback diagnostic API runs on `http://127.0.0.1:8765/health` and `http://127.0.0.1:8765/apps` (never bound to `0.0.0.0`).

## Running Unit Tests

```bash
pytest -v test_agent.py
```

## Troubleshooting

- **Token rejected / 401**: Device access was revoked or expired in ULTRON Devices. Re-generate a pairing code and run with `--pair <CODE>`.
- **App not installed**: Update `DEFAULT_WINDOWS_APPS` in `allowlist.py` with the executable path on your machine.
- **Unlock behavior**: Windows Credential Guard and Winlogon prohibit bypassing interactive authentication. ULTRON notifies you to sign in using Windows Hello, PIN, or password.
