package com.ultron.agent

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private val httpClient = OkHttpClient()
    private lateinit var tokenStore: TokenStore
    private lateinit var statusView: TextView
    private lateinit var hubUrlInput: EditText
    private lateinit var codeInput: EditText

    private val qrLauncher = registerForActivityResult(ScanContract()) { result ->
        val raw = result.contents ?: return@registerForActivityResult
        try {
            val payload = JSONObject(raw)
            hubUrlInput.setText(payload.optString("hubUrl"))
            codeInput.setText(payload.optString("code"))
            redeemCode(payload.optString("hubUrl"), payload.optString("code"))
        } catch (_: Exception) {
            statusView.text = "Invalid ULTRON QR payload."
        }
    }

    private val notifPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tokenStore = TokenStore(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        statusView = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, 24)
        }
        hubUrlInput = EditText(this).apply {
            hint = "ULTRON Hub URL (e.g. http://192.168.1.10:3000)"
        }
        codeInput = EditText(this).apply {
            hint = "6-character Pairing Code"
        }

        val scanQrBtn = Button(this).apply {
            text = "Scan ULTRON QR Code"
            setOnClickListener {
                qrLauncher.launch(
                    ScanOptions().apply {
                        setPrompt("Scan QR code from ULTRON Devices drawer")
                        setBeepEnabled(false)
                    },
                )
            }
        }

        val pairBtn = Button(this).apply {
            text = "Pair with Code"
            setOnClickListener {
                redeemCode(hubUrlInput.text.toString(), codeInput.text.toString())
            }
        }

        val enableAdminBtn = Button(this).apply {
            text = "Enable Lock Permission (Device Admin)"
            setOnClickListener {
                val admin = ComponentName(this@MainActivity, UltronDeviceAdminReceiver::class.java)
                val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
                    putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
                    putExtra(
                        DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                        "Allows ULTRON to lock this phone when you issue a verified lock command.",
                    )
                }
                startActivity(intent)
            }
        }

        val startServiceBtn = Button(this).apply {
            text = "Start / Reconnect Agent Service"
            setOnClickListener { startAgentService() }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            addView(statusView)
            addView(hubUrlInput)
            addView(codeInput)
            addView(pairBtn)
            addView(scanQrBtn)
            addView(enableAdminBtn)
            addView(startServiceBtn)
        }
        setContentView(root)
        refreshStatusText()
    }

    private fun refreshStatusText() {
        val creds = tokenStore.load()
        statusView.text = if (creds == null) {
            "Status: Not Paired\nGenerate a pairing code in ULTRON Hub -> Devices -> Pair Device."
        } else {
            "Status: Paired as ${creds.deviceName}\nHub: ${creds.hubUrl}"
        }
    }

    private fun redeemCode(rawHubUrl: String, rawCode: String) {
        val hubUrl = rawHubUrl.trim().trimEnd('/')
        val code = rawCode.trim().uppercase()
        if (hubUrl.isEmpty() || code.isEmpty()) {
            statusView.text = "Hub URL and pairing code are required."
            return
        }

        statusView.text = "Redeeming pairing code..."
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val apps = AppRegistry.queryLaunchableApps(this@MainActivity)
                val bodyJson = JSONObject().apply {
                    put("code", code)
                    put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
                    put("osVersion", "Android ${Build.VERSION.RELEASE}")
                    put("installedApps", AppRegistry.toJsonArray(apps))
                }
                val req = Request.Builder()
                    .url("$hubUrl/api/ultron/pair/redeem")
                    .post(bodyJson.toString().toRequestBody("application/json".toMediaType()))
                    .build()

                val resp = httpClient.newCall(req).execute()
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    throw RuntimeException("HTTP ${resp.code}: $text")
                }

                val data = JSONObject(text)
                val device = data.getJSONObject("device")
                val token = data.getString("token")
                val wsScheme = if (hubUrl.startsWith("https://")) "wss://" else "ws://"
                val wsHost = hubUrl.removePrefix("https://").removePrefix("http://")

                tokenStore.save(
                    AgentCredentials(
                        hubUrl = hubUrl,
                        wsUrl = "$wsScheme$wsHost/ws/agent",
                        deviceId = device.getString("id"),
                        deviceName = device.getString("name"),
                        token = token,
                    ),
                )

                withContext(Dispatchers.Main) {
                    refreshStatusText()
                    startAgentService()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    statusView.text = "Pairing failed: ${e.message}"
                }
            }
        }
    }

    private fun startAgentService() {
        val intent = Intent(this, UltronAgentService::class.java)
        ContextCompat.startForegroundService(this, intent)
        refreshStatusText()
    }
}
