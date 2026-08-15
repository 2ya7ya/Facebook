```bash
cd ~/facebook || exit 1
unzip -o "$HOME/storage/downloads/facebook_reels_fast_media_pipeline_v55.zip" -d ~/facebook
npm install
git add .
git commit -m "Optimize Reel upload playback and library media loading"
git push origin main
```
