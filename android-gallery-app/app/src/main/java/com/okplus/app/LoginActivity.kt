package com.okplus.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import com.okplus.app.databinding.ActivityLoginBinding
import com.okplus.app.nativeui.ApiClient

class LoginActivity : AppCompatActivity() {
    private lateinit var binding: ActivityLoginBinding
    private lateinit var api: ApiClient

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)
        api = ApiClient(this)
        if (api.hasSession()) { openMain(); return }
        binding.loginButton.setOnClickListener { login() }
    }

    private fun login() {
        val id = binding.emailField.text.toString().trim()
        val pass = binding.passwordField.text.toString()
        if (id.isBlank() || pass.isBlank()) {
            binding.loginError.text = "Enter your login and password"
            binding.loginError.visibility = View.VISIBLE
            return
        }
        binding.loginButton.isEnabled = false
        binding.loginProgress.visibility = View.VISIBLE
        binding.loginError.visibility = View.GONE
        Thread {
            runCatching { api.login(id, pass) }
                .onSuccess { result -> runOnUiThread {
                    binding.loginProgress.visibility = View.GONE
                    binding.loginButton.isEnabled = true
                    if (result.ok) openMain() else {
                        binding.loginError.text = "Login failed (${result.code})"
                        binding.loginError.visibility = View.VISIBLE
                    }
                }}
                .onFailure { e -> runOnUiThread {
                    binding.loginProgress.visibility = View.GONE
                    binding.loginButton.isEnabled = true
                    binding.loginError.text = e.message ?: "Connection failed"
                    binding.loginError.visibility = View.VISIBLE
                }}
        }.start()
    }

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
