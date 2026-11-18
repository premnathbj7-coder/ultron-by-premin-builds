package com.ultron.agent

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import org.json.JSONArray
import org.json.JSONObject

data class LaunchableApp(
    val alias: String,
    val packageName: String,
    val displayName: String,
)

object AppRegistry {
    private val KNOWN_ALIAS_PACKAGES = mapOf(
        "whatsapp" to "com.whatsapp",
        "youtube" to "com.google.android.youtube",
        "instagram" to "com.instagram.android",
        "spotify" to "com.spotify.music",
        "chrome" to "com.android.chrome",
        "gmail" to "com.google.android.gm",
        "maps" to "com.google.android.apps.maps",
        "settings" to "com.android.settings",
        "camera" to "com.android.camera",
    )

    fun queryLaunchableApps(context: Context): List<LaunchableApp> {
        val pm = context.packageManager
        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val resolved = pm.queryIntentActivities(mainIntent, PackageManager.MATCH_ALL)
        val apps = mutableListOf<LaunchableApp>()
        val seenPackages = mutableSetOf<String>()

        for (info in resolved) {
            val pkg = info.activityInfo?.packageName ?: continue
            if (!seenPackages.add(pkg)) continue
            val label = info.loadLabel(pm)?.toString()?.trim().orEmpty()
            if (label.isEmpty()) continue
            val knownAlias = KNOWN_ALIAS_PACKAGES.entries
                .firstOrNull { it.value == pkg }?.key
                ?: label.lowercase()
            apps.add(
                LaunchableApp(
                    alias = knownAlias,
                    packageName = pkg,
                    displayName = label,
                )
            )
        }
        return apps.sortedBy { it.displayName.lowercase() }
    }

    fun toJsonArray(apps: List<LaunchableApp>): JSONArray {
        val arr = JSONArray()
        for (app in apps) {
            arr.put(
                JSONObject().apply {
                    put("alias", app.alias)
                    put("identifier", app.packageName)
                    put("displayName", app.displayName)
                }
            )
        }
        return arr
    }

    fun resolveLaunchIntent(context: Context, query: String): Pair<LaunchableApp?, Intent?> {
        val clean = query.trim().lowercase()
        val apps = queryLaunchableApps(context)
        val matched = apps.firstOrNull {
            it.alias == clean ||
                it.displayName.lowercase() == clean ||
                it.packageName.lowercase() == clean ||
                it.displayName.lowercase().contains(clean)
        } ?: KNOWN_ALIAS_PACKAGES[clean]?.let { pkg ->
            apps.firstOrNull { it.packageName == pkg }
        } ?: return Pair(null, null)

        val launchIntent = context.packageManager.getLaunchIntentForPackage(matched.packageName)
        launchIntent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return Pair(matched, launchIntent)
    }
}
