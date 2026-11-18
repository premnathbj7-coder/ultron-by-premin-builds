# ULTRON Device Agent (Android Companion App)

Kotlin Android application that pairs with your ULTRON Hub via QR code or one-time 6-character pairing code and executes authorized commands over an authenticated WebSocket channel.

## Build & Install (Android Studio)

1. Open `/agents/android` in **Android Studio Ladybug (2024.2+)** or newer (Gradle 8.7 / AGP 8.7.2 / Kotlin 2.0.21 / compileSdk 35 / minSdk 26).
2. Connect an Android device (USB debugging) or Android Emulator and run `:app`.
3. Note: For real local Wi-Fi testing, run ULTRON Hub with TLS (`wss://` / `https://`) or ensure both devices share the same trusted LAN (`usesCleartextTraffic="true"` is enabled only for local LAN development; disable it in release builds when using `wss://`).

## Permissions & Security Policies

- `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`: Maintains a user-visible persistent Foreground Service notification while connected to ULTRON Hub.
- `<queries>` (`ACTION_MAIN` + `CATEGORY_LAUNCHER`): Allows Android 11+ `PackageManager` discovery of launchable apps so ULTRON validates installed apps accurately.
- `DeviceAdminReceiver` (`<force-lock />`): Required only if you enable remote device locking via `DevicePolicyManager.lockNow()`.
- **Android 10+ Background Activity Launch (BAL) Restrictions**: When the screen is locked or Android denies background activity starts, `UltronAgentService` does **not** attempt workarounds—instead it posts an actionable high-priority notification so you can tap to open the app immediately.
- **Lock Screen Security**: `UnlockPromptActivity` uses `KeyguardManager.requestDismissKeyguard()` and `BiometricPrompt`, always requiring fingerprint, PIN, or password. Lock screens are never bypassed.

## Troubleshooting

- **Doze Mode Disconnects**: Exclude `ULTRON Device Agent` from battery optimization in Android Settings if you need long-lived background standby connectivity.
- **Lock Permission Denied**: Tap **Enable Lock Permission (Device Admin)** inside the app before issuing `"Lock my phone"`.
