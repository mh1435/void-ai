# Void — Cloud version (shared with a friend)

This is the multi-user version of Void. Unlike the phone/Termux setup, this
runs on a free cloud host so both you and a friend can open the same link
from anywhere, with **separate** chat histories, settings, and API keys —
you won't see each other's conversations.

## What's different from the phone version

- `void_web_cloud.py` replaces `void_web.py` — same brain, but each visitor
  gets identified by a private browser cookie and their own storage folder
  instead of one shared memory file.
- Runs on Render's free tier instead of your phone.
- Each person needs to add their own Gemini/Groq/OpenRouter key in
  Settings — keys are no longer shared automatically.

## The real trade-off of "free"

Render's free tier puts the app to sleep after a period of no traffic.
The first request after it's been asleep takes about 10–30 seconds to wake
up — totally normal, not broken, just the cost of zero dollars. After that
first slow request, it's fast again until it goes quiet once more.

## Setup steps

### 1. Create a free GitHub account (skip if you have one)
https://github.com/signup

### 2. Create a new repository
- Go to https://github.com/new
- Name it anything, e.g. `void-ai`
- Keep it **Private** if you don't want the code public
- Don't add a README (we already have files to upload)

### 3. Upload these files to that repository
From the repo page, use "uploading an existing file" and drag in:
- `void_web_cloud.py`
- `index.html`
- `style.css`
- `app.js`
- `manifest.json`
- `sw.js`
- `icon-192.png`
- `icon-512.png`
- `render.yaml`

Commit the upload.

### 4. Create a free Render account
https://dashboard.render.com/register — sign up with the same GitHub
account for the smoothest connection.

### 5. Create a new Web Service
- Click **New +** → **Web Service**
- Connect your GitHub account if prompted, then select your `void-ai` repo
- Render should auto-detect `render.yaml` and fill in the settings —
  if it asks anyway, set:
  - **Runtime**: Python 3
  - **Build Command**: (leave blank)
  - **Start Command**: `python3 void_web_cloud.py`
  - **Plan**: Free
- Click **Create Web Service**

### 6. Wait for the first deploy
Takes a few minutes. When it's done, Render gives you a URL like:
```
https://void-ai-xxxx.onrender.com
```

### 7. Share that link with your friend
That's it — that URL is the actual shared app. Anyone who opens it gets
their own private cookie, their own settings, their own chat history.

### 8. Each person adds their own API key
Open the link → Settings → API keys → paste a free Gemini/Groq/OpenRouter
key. This is per-person now, not shared.

## Updating the app later

Whenever I give you new files to update this cloud version, the same
upload-to-GitHub step (step 3) is what pushes the update — Render
automatically redeploys within a minute or two of a GitHub change.
