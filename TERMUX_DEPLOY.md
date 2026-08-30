# Deploy website Page 47

Copy `facebook_website_page47_fast_post_visibility.zip` to the phone's Downloads folder, then run:

```sh
cd ~/facebook || exit 1

unzip -o \
"$HOME/storage/downloads/facebook_website_page47_fast_post_visibility.zip" \
-d ~/facebook

git add -A
git commit -m "Make website posts appear immediately after confirmation"
git push origin main
```

This update changes `server.js`, `upload/app-data.js`, and `upload/messenger.js`. It keeps the backend pagination and confirmed-post response changes, stops the website from downloading the complete feed after a post or edit, sends a lightweight live post-created event to other open website sessions, and checks only the four newest posts as a fallback.
