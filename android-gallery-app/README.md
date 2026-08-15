# OK Plus Android gallery app

This Android wrapper loads the existing Render website and replaces WebView media file requests with a native, in-app gallery.

## Included in the first build

- Three-column MediaStore photo/video grid
- Recent media first
- Album filtering
- Photo and video thumbnails
- Video duration labels
- Single selection
- Numbered multi-selection
- Camera shortcut
- Stable local `content://` media references returned to the website
- Existing website login cookies, microphone access, navigation, and Android back handling

## Website URL

The default URL is configured in `gradle.properties`:

```properties
WEB_APP_URL=https://ok-plus-1dd4.onrender.com
```

Change that value if the Render address changes.

## Build without a computer

Push the project to GitHub. The `Build Android Gallery App` workflow builds a debug APK automatically. In GitHub, open **Actions**, select the workflow run, and download the `ok-plus-gallery-debug-apk` artifact.

Android 13 and newer ask for photo/video access on first use. Android 14 may offer full access or access to selected media only; the gallery displays whatever the user grants.
