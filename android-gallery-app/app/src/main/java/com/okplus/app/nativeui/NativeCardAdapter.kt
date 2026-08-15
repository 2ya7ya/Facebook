package com.okplus.app.nativeui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.okplus.app.databinding.ItemNativeCardBinding

class NativeCardAdapter : RecyclerView.Adapter<NativeCardAdapter.Holder>() {
    private val items = mutableListOf<NativeCard>()

    fun submit(newItems: List<NativeCard>) {
        items.clear(); items.addAll(newItems); notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        return Holder(ItemNativeCardBinding.inflate(LayoutInflater.from(parent.context), parent, false))
    }

    override fun getItemCount() = items.size

    override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(items[position])

    class Holder(private val b: ItemNativeCardBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(item: NativeCard) {
            b.cardTitle.text = item.title
            b.cardSubtitle.text = item.subtitle
            b.cardBody.text = item.body
            b.cardSubtitle.visibility = if (item.subtitle.isBlank()) android.view.View.GONE else android.view.View.VISIBLE
            b.cardBody.visibility = if (item.body.isBlank()) android.view.View.GONE else android.view.View.VISIBLE
        }
    }
}
