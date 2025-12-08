# Daily Podcasts for Spotify

A Python script that creates and maintains a Spotify playlist with the latest episodes from your favorite daily podcasts. Run it each morning and your playlist is ready to go.

## Why?

Spotify doesn't auto-queue podcast episodes. If you listen to multiple daily shows (news briefings, etc.), you have to manually find and queue each one every morning. This script does it for you.

## Features

- Creates a private "Daily Podcasts" playlist
- Clears old episodes and adds today's latest
- Supports multiple podcasts
- Custom playlist cover image
- Caches auth tokens (only authorize once)

## Setup

### 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Fill in:
   - **App name:** Daily Podcasts
   - **App description:** Daily podcast playlist updater
   - **Redirect URI:** `http://127.0.0.1:8888/callback`
4. Click **Save**
5. Go to **Settings** and copy your **Client ID** and **Client Secret**

### 2. Configure the Script

Edit `queue_podcasts.py` and add your credentials:

```python
SPOTIFY_CLIENT_ID = "your_client_id_here"
SPOTIFY_CLIENT_SECRET = "your_client_secret_here"
```

Add your podcasts to the `PODCASTS` list:

```python
PODCASTS = [
    {
        "name": "FT News Briefing",
        "show_id": "1410RabA4XOqO6IV8p0gYF"
    },
    {
        "name": "Up First from NPR",
        "show_id": "2mTUnDkuKUkhiueKcVWoP0"
    }
]
```

### 3. Install Dependencies

```bash
pip install requests
```

### 4. Run

```bash
python queue_podcasts.py
```

The first run opens a browser for Spotify authorization. After that, tokens are cached and it runs without interaction.

## Finding a Podcast's Show ID

1. Open the podcast in Spotify
2. Click **⋯** → **Share** → **Copy link to show**
3. The show ID is in the URL between `/show/` and `?`:

```
https://open.spotify.com/show/2mTUnDkuKUkhiueKcVWoP0?si=...
                               └─────────────────────┘
                                     show_id
```

## Options

```bash
# Default: today's episodes, replaces playlist contents
python queue_podcasts.py

# Include episodes from the last 2 days
python queue_podcasts.py --days 2

# Add new episodes without removing old ones
python queue_podcasts.py --keep-old

# Use a custom playlist name
python queue_podcasts.py --playlist "Morning News"

# Combine options
python queue_podcasts.py --days 2 --keep-old --playlist "Weekly Pods"
```

## Custom Playlist Cover

Set a custom cover image by editing the config:

```python
PLAYLIST_COVER_IMAGE = "/path/to/cover.jpg"
```

Requirements:
- JPEG format
- Square dimensions (300x300 or 640x640 recommended)
- Under 256KB

## Automation

### macOS/Linux: Run daily with cron

```bash
crontab -e
```

Add:

```
0 6 * * * cd /path/to/daily-podcasts && python3 queue_podcasts.py >> ~/podcasts.log 2>&1
```

### macOS: Run at login with LaunchAgent

Create `~/Library/LaunchAgents/com.dailypodcasts.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dailypodcasts</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/path/to/queue_podcasts.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
</dict>
</plist>
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.dailypodcasts.plist
```

## Troubleshooting

### "Invalid redirect URI"

Make sure your Spotify app's Redirect URI is exactly:
```
http://127.0.0.1:8888/callback
```

Click **Add** after entering it, then **Save**.

### "Authorization failed" or token issues

Clear cached tokens and re-authorize:

```bash
rm ~/.spotify_podcast_token.json
python queue_podcasts.py
```

### Need to add a new scope (e.g., after updating the script)

Same fix — clear tokens and re-authorize:

```bash
rm ~/.spotify_podcast_token.json
python queue_podcasts.py
```

### Playlist was deleted

The script will recreate it on the next run. To reset the cached playlist ID:

```bash
rm ~/.spotify_podcast_playlist.json
python queue_podcasts.py
```

## License

MIT