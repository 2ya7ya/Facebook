package com.okplus.app.nativeui

import android.content.Context
import com.okplus.app.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class ApiClient(private val context: Context) {
    private val prefs = context.getSharedPreferences("native_session", Context.MODE_PRIVATE)

    data class Result(val code: Int, val body: String, val setCookie: String?) {
        val ok get() = code in 200..299
    }

    fun hasSession(): Boolean = !prefs.getString("cookie", null).isNullOrBlank()
    fun clearSession() = prefs.edit().remove("cookie").apply()

    fun request(path: String, method: String = "GET", json: JSONObject? = null): Result {
        val conn = (URL(BuildConfig.API_BASE_URL.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15000
            readTimeout = 20000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "OKPlusNativeAndroid/2.0")
            prefs.getString("cookie", null)?.let { setRequestProperty("Cookie", it) }
            if (json != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        if (json != null) conn.outputStream.use { it.write(json.toString().toByteArray()) }
        val code = conn.responseCode
        val cookie = conn.getHeaderField("Set-Cookie")?.substringBefore(';')
        if (!cookie.isNullOrBlank()) prefs.edit().putString("cookie", cookie).apply()
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        conn.disconnect()
        return Result(code, body, cookie)
    }

    fun login(identity: String, password: String): Result {
        val tries = listOf(
            JSONObject().put("email", identity).put("password", password),
            JSONObject().put("username", identity).put("password", password),
            JSONObject().put("identity", identity).put("password", password)
        )
        var last = Result(400, "", null)
        for (payload in tries) {
            last = request("/api/login", "POST", payload)
            if (last.ok) break
        }
        return last
    }

    fun cardsFor(path: String, mode: String): List<NativeCard> {
        val res = request(path)
        if (res.code == 401 || res.code == 403) throw SecurityException("SESSION_EXPIRED")
        if (!res.ok) throw IllegalStateException("HTTP ${res.code}: ${res.body.take(180)}")
        return parseCards(res.body, mode)
    }

    private fun parseCards(raw: String, mode: String): List<NativeCard> {
        val root: Any = raw.trim().let { if (it.startsWith("[")) JSONArray(it) else JSONObject(it) }
        val arr = when (root) {
            is JSONArray -> root
            is JSONObject -> firstArray(root, mode)
            else -> JSONArray()
        }
        val out = ArrayList<NativeCard>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            out += when (mode) {
                "posts" -> NativeCard(
                    pick(o, "authorName", "author_name", "name", "username", "author") ?: "Post",
                    pick(o, "createdAt", "created_at", "time", "date") ?: "",
                    pick(o, "text", "content", "caption", "body") ?: ""
                )
                "reels" -> NativeCard(
                    pick(o, "authorName", "author_name", "name", "username") ?: "Reel",
                    "${pick(o, "views", "viewCount", "view_count") ?: "0"} views",
                    pick(o, "caption", "text", "description") ?: ""
                )
                "messages" -> NativeCard(
                    pick(o, "name", "displayName", "display_name", "username", "otherName") ?: "Conversation",
                    pick(o, "time", "updatedAt", "updated_at", "lastMessageAt") ?: "",
                    pick(o, "lastMessage", "last_message", "snippet", "message") ?: ""
                )
                "notifications" -> NativeCard(
                    pick(o, "title", "actorName", "actor_name", "name") ?: "Notification",
                    pick(o, "createdAt", "created_at", "time") ?: "",
                    pick(o, "text", "message", "body", "description") ?: ""
                )
                "profile" -> NativeCard(
                    pick(o, "name", "displayName", "display_name", "username") ?: "Profile",
                    pick(o, "username", "email") ?: "",
                    listOfNotNull(pick(o, "bio"), pick(o, "location"), pick(o, "work"), pick(o, "education")).joinToString("\n")
                )
                else -> NativeCard("Item", "", o.toString())
            }
        }
        if (out.isEmpty() && root is JSONObject && mode == "profile") {
            out += NativeCard(
                pick(root, "name", "displayName", "display_name", "username") ?: "Profile",
                pick(root, "username", "email") ?: "",
                listOfNotNull(pick(root, "bio"), pick(root, "location"), pick(root, "work"), pick(root, "education")).joinToString("\n")
            )
        }
        return out
    }

    private fun firstArray(o: JSONObject, mode: String): JSONArray {
        val keys = when (mode) {
            "posts" -> listOf("posts", "items", "data")
            "reels" -> listOf("reels", "items", "data")
            "messages" -> listOf("conversations", "threads", "inbox", "items", "data")
            "notifications" -> listOf("notifications", "items", "data")
            else -> emptyList()
        }
        for (k in keys) o.optJSONArray(k)?.let { return it }
        return JSONArray()
    }

    private fun pick(o: JSONObject, vararg keys: String): String? {
        for (k in keys) if (o.has(k) && !o.isNull(k)) {
            val v = o.opt(k)?.toString()?.trim()
            if (!v.isNullOrBlank() && v != "null") return v
        }
        return null
    }
}
