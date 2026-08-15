package com.okplus.app

import android.content.ContentResolver
import android.graphics.Bitmap
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.util.Size
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.okplus.app.databinding.ItemMediaBinding
import java.util.concurrent.Executors
import kotlin.math.max

class MediaAdapter(
    private val resolver: ContentResolver,
    private val onClick: (MediaItem) -> Unit
) : RecyclerView.Adapter<MediaAdapter.MediaHolder>() {

    private val items = mutableListOf<MediaItem>()
    private val selectedIds = linkedSetOf<Long>()
    private val executor = Executors.newFixedThreadPool(4)
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<Long, Bitmap>(max(8 * 1024, (Runtime.getRuntime().maxMemory() / 1024 / 12).toInt())) {
        override fun sizeOf(key: Long, value: Bitmap): Int = value.byteCount / 1024
    }

    var multipleMode = false
        set(value) {
            field = value
            if (!value) selectedIds.clear()
            notifyDataSetChanged()
        }

    fun submit(next: List<MediaItem>) {
        items.clear()
        items.addAll(next)
        selectedIds.retainAll(next.mapTo(hashSetOf()) { it.id })
        notifyDataSetChanged()
    }

    fun toggle(item: MediaItem) {
        if (!selectedIds.add(item.id)) selectedIds.remove(item.id)
        val position = items.indexOfFirst { it.id == item.id }
        if (position != RecyclerView.NO_POSITION) notifyItemChanged(position)
    }

    fun selectedItems(): List<MediaItem> = items.filter { selectedIds.contains(it.id) }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MediaHolder {
        val binding = ItemMediaBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        val size = parent.resources.displayMetrics.widthPixels / 3
        binding.root.layoutParams = ViewGroup.LayoutParams(size, size)
        return MediaHolder(binding)
    }

    override fun onBindViewHolder(holder: MediaHolder, position: Int) = holder.bind(items[position])
    override fun getItemCount(): Int = items.size

    inner class MediaHolder(private val binding: ItemMediaBinding) : RecyclerView.ViewHolder(binding.root) {
        private var cancellation: CancellationSignal? = null

        fun bind(item: MediaItem) {
            cancellation?.cancel()
            binding.thumbnail.setImageDrawable(null)
            binding.thumbnail.tag = item.id
            val order = selectedIds.indexOf(item.id)
            val selected = order >= 0
            binding.selectionBadge.visibility = if (multipleMode) View.VISIBLE else View.GONE
            binding.selectionBadge.text = if (selected) (order + 1).toString() else ""
            binding.selectionBadge.alpha = if (selected) 1f else .45f
            binding.selectionOverlay.visibility = if (selected) View.VISIBLE else View.GONE
            binding.duration.visibility = if (item.isVideo) View.VISIBLE else View.GONE
            binding.duration.text = formatDuration(item.durationMs)
            binding.root.setOnClickListener { onClick(item) }

            cache.get(item.id)?.let {
                binding.thumbnail.setImageBitmap(it)
                return
            }

            val signal = CancellationSignal()
            cancellation = signal
            executor.execute {
                val bitmap = runCatching {
                    resolver.loadThumbnail(item.uri, Size(420, 420), signal)
                }.getOrNull()
                if (bitmap != null) cache.put(item.id, bitmap)
                main.post {
                    if (binding.thumbnail.tag == item.id && bitmap != null) {
                        binding.thumbnail.setImageBitmap(bitmap)
                    }
                }
            }
        }

        private fun formatDuration(durationMs: Long): String {
            val seconds = (durationMs / 1000).coerceAtLeast(0)
            return "%d:%02d".format(seconds / 60, seconds % 60)
        }
    }

    override fun onViewRecycled(holder: MediaHolder) {
        super.onViewRecycled(holder)
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
