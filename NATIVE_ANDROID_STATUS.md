# OKPlus native Android migration — v162

This build removes the WebView architecture. The launcher is a Kotlin Activity and the core navigation is native Android UI.

Native in this build:
- Login screen and session cookie handling
- Home/feed screen backed by `/api/posts`
- Reels list backed by `/api/reels`
- Messenger inbox backed by `/api/messaging/inbox`
- Notifications backed by `/api/notifications`
- Profile backed by `/api/profile`
- Bottom navigation
- Custom photo/video gallery picker

Still to migrate for feature parity:
- Rich media rendering/playback
- Post composer/upload
- Full comments/reactions/share flows
- Reel player/editor/posting
- Conversation screen, voice notes, reactions, reply/forward/delete
- Friends/members/search screens
- Profile editing/detail subpages
- Push notifications and background sync

The Node/Render service remains the API/backend. No website page or WebView is loaded by the Android client.
