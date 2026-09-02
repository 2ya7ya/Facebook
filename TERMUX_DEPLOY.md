# Deploy FaceTok Reel playback backend fix v3

Deploy this backend before installing the v81 Android APK.

```bash
cd ~/facebook || exit 1
unzip -o "$HOME/storage/downloads/FaceTok-website-reel-playback-fix-v3.zip" -d .
git add -A
git commit -m "Prevent incompatible native Reel playback"
git push origin main
```

After GitHub Actions succeeds, verify:

```bash
curl -i --connect-timeout 10 --max-time 20 https://facetokapp.duckdns.org/api/health
```
