```bash
cd ~/facebook || exit 1
unzip -o "$HOME/storage/downloads/facebook_reels_v287_admin_audit_suspension_sessions.zip" -d ~/facebook
npm install
git add .
git commit -m "Improve admin audit suspension and sessions"
git push origin main
```
