package com.okplus.app

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.recyclerview.widget.GridLayoutManager
import com.okplus.app.databinding.ActivityGalleryPickerBinding
import java.io.File
import java.util.concurrent.Executors

class GalleryPickerActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_URIS = "selected_uris"
        const val EXTRA_ALLOW_MULTIPLE = "allow_multiple"
        const val EXTRA_ACCEPT = "accept"
    }

    private lateinit var binding: ActivityGalleryPickerBinding
    private lateinit var adapter: MediaAdapter
    private val executor = Executors.newSingleThreadExecutor()
    private var allMedia = emptyList<MediaItem>()
    private var allowMultiple = true
    private var multipleMode = false
    private var cameraUri: Uri? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (hasMediaPermission()) loadMedia()
        else {
            binding.loading.visibility = View.GONE
            binding.emptyView.visibility = View.VISIBLE
            binding.emptyView.text = getString(R.string.permission_needed)
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else Toast.makeText(this, "Camera permission is required.", Toast.LENGTH_SHORT).show()
    }

    private val cameraLauncher = registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val uri = cameraUri
        if (saved && uri != null) returnSelection(listOf(uri))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityGalleryPickerBinding.inflate(layoutInflater)
        setContentView(binding.root)
        allowMultiple = intent.getBooleanExtra(EXTRA_ALLOW_MULTIPLE, true)

        adapter = MediaAdapter(contentResolver, ::onMediaTapped)
        binding.mediaGrid.layoutManager = GridLayoutManager(this, 3)
        binding.mediaGrid.adapter = adapter
        binding.mediaGrid.setHasFixedSize(true)
        binding.closeButton.setOnClickListener { cancelPicker() }
        binding.cameraButton.setOnClickListener { ensureCameraPermission() }
        binding.multipleButton.visibility = if (allowMultiple) View.VISIBLE else View.GONE
        binding.multipleButton.setOnClickListener { toggleMultipleMode() }
        binding.doneButton.setOnClickListener {
            val selected = adapter.selectedItems()
            if (selected.isNotEmpty()) returnSelection(selected.map { it.uri })
        }
        binding.albumSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val album = parent?.getItemAtPosition(position)?.toString().orEmpty()
                filterAlbum(album)
            }
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }

        if (hasMediaPermission()) loadMedia() else permissionLauncher.launch(requiredMediaPermissions())
    }

    private fun requiredMediaPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO
        )
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun hasMediaPermission(): Boolean = when {
        Build.VERSION.SDK_INT >= 34 -> {
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED
        }
        Build.VERSION.SDK_INT >= 33 -> {
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED
        }
        else -> ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    private fun loadMedia() {
        binding.loading.visibility = View.VISIBLE
        binding.emptyView.visibility = View.GONE
        executor.execute {
            val loaded = queryMedia()
            runOnUiThread {
                allMedia = loaded
                installAlbums(loaded)
                binding.loading.visibility = View.GONE
                binding.emptyView.visibility = if (loaded.isEmpty()) View.VISIBLE else View.GONE
            }
        }
    }

    private fun queryMedia(): List<MediaItem> {
        val accept = intent.getStringExtra(EXTRA_ACCEPT).orEmpty()
        val includeImages = !accept.contains("video") || accept.contains("image")
        val includeVideos = !accept.contains("image") || accept.contains("video")
        val mediaTypes = buildList {
            if (includeImages) add(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE)
            if (includeVideos) add(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO)
        }
        if (mediaTypes.isEmpty()) return emptyList()

        val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
        val projection = arrayOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.Video.VideoColumns.DURATION,
            MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME,
            MediaStore.MediaColumns.DATE_ADDED
        )
        val placeholders = mediaTypes.joinToString(",") { "?" }
        val selection = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($placeholders)"
        val args = mediaTypes.map(Int::toString).toTypedArray()
        val output = mutableListOf<MediaItem>()

        runCatching {
            contentResolver.query(
                collection,
                projection,
                selection,
                args,
                "${MediaStore.MediaColumns.DATE_ADDED} DESC"
            )?.use { cursor ->
                val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
                val typeColumn = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
                val mimeColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE)
                val durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.VideoColumns.DURATION)
                val albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.ImageColumns.BUCKET_DISPLAY_NAME)
                val dateColumn = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idColumn)
                    val mediaType = cursor.getInt(typeColumn)
                    val mime = cursor.getString(mimeColumn) ?: if (mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO) "video/*" else "image/*"
                    val duration = if (cursor.isNull(durationColumn)) 0L else cursor.getLong(durationColumn)
                    val album = cursor.getString(albumColumn)?.takeIf { it.isNotBlank() } ?: "Other"
                    val dateAdded = cursor.getLong(dateColumn)
                    output += MediaItem(id, ContentUris.withAppendedId(collection, id), mime, duration, album, dateAdded)
                }
            }
        }
        return output
    }

    private fun installAlbums(items: List<MediaItem>) {
        val albums = listOf(getString(R.string.gallery)) + items.map { it.album }.distinct().sorted()
        binding.albumSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, albums)
        filterAlbum(getString(R.string.gallery))
    }

    private fun filterAlbum(album: String) {
        val gallery = getString(R.string.gallery)
        val filtered = if (album.isBlank() || album == gallery) allMedia else allMedia.filter { it.album == album }
        adapter.submit(filtered)
        binding.emptyView.visibility = if (filtered.isEmpty() && binding.loading.visibility != View.VISIBLE) View.VISIBLE else View.GONE
        updateDoneButton()
    }

    private fun toggleMultipleMode() {
        multipleMode = !multipleMode
        adapter.multipleMode = multipleMode
        binding.multipleButton.isChecked = multipleMode
        binding.multipleButton.setBackgroundColor(if (multipleMode) getColor(R.color.soft_gray) else android.graphics.Color.TRANSPARENT)
        updateDoneButton()
    }

    private fun onMediaTapped(item: MediaItem) {
        if (!multipleMode) {
            returnSelection(listOf(item.uri))
            return
        }
        adapter.toggle(item)
        updateDoneButton()
    }

    private fun updateDoneButton() {
        val count = adapter.selectedItems().size
        binding.doneButton.visibility = if (multipleMode && count > 0) View.VISIBLE else View.GONE
        binding.doneButton.text = if (count > 0) "${getString(R.string.done)} ($count)" else getString(R.string.done)
    }

    private fun ensureCameraPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera()
        else cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    private fun launchCamera() {
        val directory = File(cacheDir, "camera").apply { mkdirs() }
        val file = File(directory, "photo-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        cameraUri = uri
        cameraLauncher.launch(uri)
    }

    private fun returnSelection(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val result = Intent().apply {
            data = uris.first()
            putParcelableArrayListExtra(EXTRA_URIS, ArrayList(uris))
            clipData = ClipData.newUri(contentResolver, "Selected media", uris.first()).also { clip ->
                uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
            }
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        setResult(Activity.RESULT_OK, result)
        finish()
    }

    private fun cancelPicker() {
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    @Deprecated("Deprecated in Android")
    override fun onBackPressed() = cancelPicker()

    override fun onDestroy() {
        adapter.shutdown()
        executor.shutdownNow()
        super.onDestroy()
    }
}
