package com.ultron.agent

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/**
 * Policy-compliant unlock request activity.
 * Never bypasses the Android lock screen: invokes KeyguardManager.requestDismissKeyguard
 * and BiometricPrompt/device credential so the user must authenticate normally.
 */
class UnlockPromptActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val label = TextView(this).apply {
            text = "ULTRON Unlock Requested\nPlease authenticate with your fingerprint, PIN, or password."
            textSize = 18f
            setPadding(48, 64, 48, 32)
        }
        val button = Button(this).apply {
            text = "Authenticate Now"
            setOnClickListener { triggerNormalAuthentication() }
        }
        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            addView(label)
            addView(button)
        }
        setContentView(layout)
        triggerNormalAuthentication()
    }

    private fun triggerNormalAuthentication() {
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (keyguard.isKeyguardLocked) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                keyguard.requestDismissKeyguard(
                    this,
                    object : KeyguardManager.KeyguardDismissCallback() {
                        override fun onDismissSucceeded() {
                            finish()
                        }
                    },
                )
            }
            return
        }

        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(
            this,
            executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    finish()
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("ULTRON Authentication Request")
            .setSubtitle("Verify your identity to unlock")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            )
            .build()
        prompt.authenticate(info)
    }
}
