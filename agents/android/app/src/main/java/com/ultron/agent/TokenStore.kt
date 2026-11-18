package com.ultron.agent

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

data class AgentCredentials(
    val hubUrl: String,
    val wsUrl: String,
    val deviceId: String,
    val deviceName: String,
    val token: String,
)

class TokenStore(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "ultron_agent_secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun save(creds: AgentCredentials) {
        prefs.edit()
            .putString("hubUrl", creds.hubUrl)
            .putString("wsUrl", creds.wsUrl)
            .putString("deviceId", creds.deviceId)
            .putString("deviceName", creds.deviceName)
            .putString("token", creds.token)
            .apply()
    }

    fun load(): AgentCredentials? {
        val hubUrl = prefs.getString("hubUrl", null) ?: return null
        val wsUrl = prefs.getString("wsUrl", null) ?: return null
        val deviceId = prefs.getString("deviceId", null) ?: return null
        val deviceName = prefs.getString("deviceName", null) ?: return null
        val token = prefs.getString("token", null) ?: return null
        return AgentCredentials(hubUrl, wsUrl, deviceId, deviceName, token)
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
