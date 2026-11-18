package com.ultron.agent

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class UltronAgentService : Service() {
    companion object {
        const val CHANNEL_SERVICE = "ultron_agent_service"
        const val CHANNEL_ACTIONS = "ultron_agent_actions"
        const val NOTIF_SERVICE_ID = 1001
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private lateinit var tokenStore: TokenStore
    private var activeSocket: WebSocket? = null

    override fun onCreate() {
        super.onCreate()
        tokenStore = TokenStore(this)
        ensureNotificationChannels()
        startForeground(NOTIF_SERVICE_ID, buildServiceNotification("Connecting to ULTRON Hub..."))
        connectWebSocket()
        startHeartbeatLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        activeSocket?.close(1000, "Service stopped")
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_SERVICE,
                    "ULTRON Connection",
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ACTIONS,
                    "ULTRON Action Requests",
                    NotificationManager.IMPORTANCE_HIGH,
                ),
            )
        }
    }

    private fun buildServiceNotification(status: String): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_SERVICE)
            .setContentTitle("ULTRON Device Agent")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
    }

    private fun updateServiceNotification(status: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_SERVICE_ID, buildServiceNotification(status))
    }

    private fun readBattery(): Pair<Int, Boolean> {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        return Pair(pct.coerceIn(0, 100), charging)
    }

    private fun isDeviceLocked(): Boolean {
        val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return km.isKeyguardLocked
    }

    private fun connectWebSocket() {
        val creds = tokenStore.load()
        if (creds == null) {
            updateServiceNotification("Not paired. Open app to pair.")
            stopSelf()
            return
        }

        val request = Request.Builder()
            .url(creds.wsUrl)
            .addHeader("Authorization", "Bearer ${creds.token}")
            .build()

        activeSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    updateServiceNotification("Connected to ULTRON Hub")
                    val (pct, charging) = readBattery()
                    val apps = AppRegistry.queryLaunchableApps(this@UltronAgentService)
                    val hello = JSONObject().apply {
                        put("type", "agent:hello")
                        put("osVersion", "Android ${Build.VERSION.RELEASE}")
                        put("batteryPercent", pct)
                        put("isCharging", charging)
                        put("isLocked", isDeviceLocked())
                        put(
                            "supportedActions",
                            JSONArray(
                                listOf(
                                    "OPEN_APPLICATION",
                                    "LOCK_DEVICE",
                                    "UNLOCK_REQUEST",
                                    "CHECK_BATTERY",
                                    "PING",
                                ),
                            ),
                        )
                        put("installedApps", AppRegistry.toJsonArray(apps))
                    }
                    webSocket.send(hello.toString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val json = JSONObject(text)
                    if (json.optString("type") == "hub:command") {
                        handleCommand(webSocket, json)
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    if (code == 4003 || code == 4001) {
                        tokenStore.clear()
                        updateServiceNotification("Access revoked. Re-pair required.")
                        stopSelf()
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    updateServiceNotification("Reconnecting to ULTRON Hub...")
                    scope.launch {
                        delay(4000)
                        if (isActive && tokenStore.load() != null) {
                            connectWebSocket()
                        }
                    }
                }
            },
        )
    }

    private fun startHeartbeatLoop() {
        scope.launch {
            while (isActive) {
                delay(15_000)
                val (pct, charging) = readBattery()
                val hb = JSONObject().apply {
                    put("type", "agent:heartbeat")
                    put("batteryPercent", pct)
                    put("isCharging", charging)
                    put("isLocked", isDeviceLocked())
                }
                activeSocket?.send(hb.toString())
            }
        }
    }

    private fun handleCommand(ws: WebSocket, cmd: JSONObject) {
        val commandId = cmd.optString("commandId")
        val action = cmd.optString("action")
        val application = cmd.optString("application")
        val (pct, charging) = readBattery()
        val locked = isDeviceLocked()

        val result = JSONObject().apply {
            put("type", "agent:command_result")
            put("commandId", commandId)
            put("batteryPercent", pct)
            put("isCharging", charging)
            put("isLocked", locked)
        }

        when (action) {
            "PING" -> {
                result.put("success", true)
                result.put("message", "Android device is online ($pct% battery).")
            }

            "CHECK_BATTERY" -> {
                result.put("success", true)
                val chargeStr = if (charging) " and charging" else ""
                result.put("message", "Phone battery is $pct%$chargeStr.")
            }

            "LOCK_DEVICE" -> {
                val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                val admin = ComponentName(this, UltronDeviceAdminReceiver::class.java)
                if (!dpm.isAdminActive(admin)) {
                    result.put("success", false)
                    result.put("errorCode", "PERMISSION_DENIED")
                    result.put(
                        "message",
                        "Device Admin permission is not enabled in ULTRON Device Agent.",
                    )
                } else {
                    dpm.lockNow()
                    result.put("success", true)
                    result.put("isLocked", true)
                    result.put("message", "Your phone has been locked.")
                }
            }

            "UNLOCK_REQUEST" -> {
                if (!locked) {
                    result.put("success", true)
                    result.put("isLocked", false)
                    result.put("message", "Your phone is already unlocked.")
                } else {
                    postUnlockNotification()
                    result.put("success", true)
                    result.put("isLocked", true)
                    result.put(
                        "message",
                        "Unlock requested. Please authenticate on your phone to unlock it.",
                    )
                }
            }

            "OPEN_APPLICATION" -> {
                val (appInfo, launchIntent) = AppRegistry.resolveLaunchIntent(this, application)
                if (appInfo == null || launchIntent == null) {
                    result.put("success", false)
                    result.put("errorCode", "APP_NOT_INSTALLED")
                    result.put("message", "$application is not installed on this Android device.")
                } else if (locked) {
                    postAppLaunchNotification(appInfo.displayName, launchIntent)
                    result.put("success", false)
                    result.put("errorCode", "DEVICE_LOCKED")
                    result.put(
                        "message",
                        "Phone is locked. Posted tap-to-open notification for ${appInfo.displayName} after you unlock.",
                    )
                } else {
                    try {
                        startActivity(launchIntent)
                        result.put("success", true)
                        result.put("message", "Opening ${appInfo.displayName} on your phone.")
                    } catch (_: Exception) {
                        // Android 10+ Background Activity Launch restriction fallback
                        postAppLaunchNotification(appInfo.displayName, launchIntent)
                        result.put("success", false)
                        result.put("errorCode", "BACKGROUND_LAUNCH_BLOCKED")
                        result.put(
                            "message",
                            "Android blocked background launch of ${appInfo.displayName}. Tap the notification on your phone to open it.",
                        )
                    }
                }
            }

            else -> {
                result.put("success", false)
                result.put("errorCode", "UNSUPPORTED_OPERATION")
                result.put("message", "Unsupported action: $action")
            }
        }

        ws.send(result.toString())
    }

    private fun postAppLaunchNotification(appName: String, launchIntent: Intent) {
        val pending = PendingIntent.getActivity(
            this,
            appName.hashCode(),
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, CHANNEL_ACTIONS)
            .setSmallIcon(android.R.drawable.ic_menu_send)
            .setContentTitle("ULTRON: Open $appName")
            .setContentText("Tap to open $appName")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(appName.hashCode(), notif)
    }

    private fun postUnlockNotification() {
        val intent = Intent(this, UnlockPromptActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pending = PendingIntent.getActivity(
            this,
            2002,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notif = NotificationCompat.Builder(this, CHANNEL_ACTIONS)
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentTitle("ULTRON Unlock Requested")
            .setContentText("Authenticate with fingerprint, PIN, or password to unlock.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setFullScreenIntent(pending, true)
            .setContentIntent(pending)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(2002, notif)
    }
}
