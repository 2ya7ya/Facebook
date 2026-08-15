package com.okplus.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import com.okplus.app.databinding.ActivityMainBinding
import com.okplus.app.nativeui.ApiClient
import com.okplus.app.nativeui.NativeCard
import com.okplus.app.nativeui.NativeCardAdapter

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var api: ApiClient
    private val adapter = NativeCardAdapter()
    private var current = "posts"

    private val galleryLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val count = result.data?.getParcelableArrayListExtra<android.net.Uri>(GalleryPickerActivity.EXTRA_URIS)?.size ?: 0
            Toast.makeText(this, "$count media item(s) selected", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        api = ApiClient(this)
        if (!api.hasSession()) { relogin(); return }

        binding.contentList.layoutManager = LinearLayoutManager(this)
        binding.contentList.adapter = adapter
        binding.bottomNav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_home -> load("posts", "Home", "/api/posts")
                R.id.nav_reels -> load("reels", "Reels", "/api/reels")
                R.id.nav_messages -> load("messages", "Messages", "/api/messaging/inbox")
                R.id.nav_notifications -> load("notifications", "Notifications", "/api/notifications")
                R.id.nav_profile -> load("profile", "Profile", "/api/profile")
                else -> false
            }
        }
        binding.createButton.setOnClickListener {
            galleryLauncher.launch(Intent(this, GalleryPickerActivity::class.java).apply {
                putExtra(GalleryPickerActivity.EXTRA_ALLOW_MULTIPLE, true)
                putExtra(GalleryPickerActivity.EXTRA_ACCEPT, "image/*,video/*")
            })
        }
        binding.searchButton.setOnClickListener {
            Toast.makeText(this, "Native search screen is next in the migration", Toast.LENGTH_SHORT).show()
        }
        load("posts", "Home", "/api/posts")
    }

    private fun load(mode: String, title: String, path: String): Boolean {
        current = mode
        binding.screenTitle.text = title
        binding.loading.visibility = View.VISIBLE
        adapter.submit(emptyList())
        Thread {
            runCatching { api.cardsFor(path, mode) }
                .onSuccess { cards -> runOnUiThread {
                    binding.loading.visibility = View.GONE
                    adapter.submit(if (cards.isEmpty()) listOf(NativeCard("Nothing here yet")) else cards)
                }}
                .onFailure { e -> runOnUiThread {
                    binding.loading.visibility = View.GONE
                    if (e is SecurityException) relogin() else adapter.submit(listOf(NativeCard("Couldn't load $title", body = e.message ?: "Unknown error")))
                }}
        }.start()
        return true
    }

    private fun relogin() {
        api.clearSession()
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }
}
