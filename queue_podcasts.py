#!/usr/bin/env python3
"""
Daily Podcasts for Spotify
---------------------------
Creates and maintains a Spotify playlist with the latest episodes
from your favorite daily podcasts.

See README.md for setup instructions.

Usage:
    python queue_podcasts.py [options]

Options:
    --days N        Include episodes from the last N days (default: 1)
    --keep-old      Don't remove old episodes, just add new ones
    --playlist NAME Custom playlist name (default: "Daily Podcasts")
"""

import sys
import json
import time
import base64
import argparse
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlencode, parse_qs, urlparse
import requests

# =============================================================================
# CONFIGURATION - Edit these values
# =============================================================================

# Spotify API credentials (from https://developer.spotify.com/dashboard)
SPOTIFY_CLIENT_ID = "your_client_id_here"
SPOTIFY_CLIENT_SECRET = "your_client_secret_here"

# Custom playlist cover image (optional)
# Set to a JPEG file path, or None to skip
# Image should be square, max 256KB
PLAYLIST_COVER_IMAGE = cover.jpg  # e.g., "/path/to/cover.jpg"

# Your podcasts - add/remove as needed
# Find show_id in Spotify URL: https://open.spotify.com/show/[SHOW_ID]?si=...
PODCASTS = [
    {
        "name": "FT News Briefing",
        "show_id": "1410RabA4XOqO6IV8p0gYF"
    },
    {
        "name": "Up First from NPR",
        "show_id": "2mTUnDkuKUkhiueKcVWoP0"
    },
    {
        "name": "The Daily",
        "show_id": "3IM0lmZxpFAY7CwMuv9H4g"
    }
]

# =============================================================================
# Don't edit below unless you know what you're doing
# =============================================================================

REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPES = "playlist-modify-public playlist-modify-private playlist-read-private ugc-image-upload"
TOKEN_CACHE = Path.home() / ".spotify_podcast_token.json"
PLAYLIST_CACHE = Path.home() / ".spotify_podcast_playlist.json"


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Handle OAuth callback from Spotify."""
    
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        if "code" in query:
            self.server.auth_code = query["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(b"""
                <html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; 
                    display: flex; justify-content: center; align-items: center; height: 100vh;
                    background: linear-gradient(135deg, #1DB954, #191414);">
                    <div style="text-align: center; color: white;">
                        <h1>&#127911; Success!</h1>
                        <p>You can close this window and return to the terminal.</p>
                    </div>
                </body></html>
            """)
        else:
            self.server.auth_code = None
            self.send_response(400)
            self.end_headers()
    
    def log_message(self, format, *args):
        pass  # Suppress HTTP logs


class SpotifyDailyPodcasts:
    """Handles Spotify authentication and playlist operations."""
    
    def __init__(self, playlist_name="Daily Podcasts"):
        self.client_id = SPOTIFY_CLIENT_ID
        self.client_secret = SPOTIFY_CLIENT_SECRET
        self.access_token = None
        self.refresh_token = None
        self.token_expiry = 0
        self.user_id = None
        self.playlist_name = playlist_name
        self.playlist_id = None
        
        if self.client_id == "your_client_id_here" or self.client_secret == "your_client_secret_here":
            print("\n❌ Missing Spotify credentials!")
            print("\nEdit queue_podcasts.py and set:")
            print("  SPOTIFY_CLIENT_ID = 'your_actual_client_id'")
            print("  SPOTIFY_CLIENT_SECRET = 'your_actual_client_secret'")
            print("\nGet these from https://developer.spotify.com/dashboard")
            sys.exit(1)
    
    def load_cached_token(self):
        """Load token from cache file if it exists."""
        if TOKEN_CACHE.exists():
            try:
                with open(TOKEN_CACHE) as f:
                    data = json.load(f)
                    self.access_token = data.get("access_token")
                    self.refresh_token = data.get("refresh_token")
                    self.token_expiry = data.get("expiry", 0)
                    return True
            except (json.JSONDecodeError, KeyError):
                pass
        return False
    
    def save_token(self):
        """Save token to cache file."""
        with open(TOKEN_CACHE, "w") as f:
            json.dump({
                "access_token": self.access_token,
                "refresh_token": self.refresh_token,
                "expiry": self.token_expiry
            }, f)
        TOKEN_CACHE.chmod(0o600)
    
    def load_playlist_cache(self):
        """Load cached playlist ID."""
        if PLAYLIST_CACHE.exists():
            try:
                with open(PLAYLIST_CACHE) as f:
                    data = json.load(f)
                    if data.get("name") == self.playlist_name:
                        self.playlist_id = data.get("id")
                        return True
            except (json.JSONDecodeError, KeyError):
                pass
        return False
    
    def save_playlist_cache(self):
        """Save playlist ID to cache."""
        with open(PLAYLIST_CACHE, "w") as f:
            json.dump({
                "name": self.playlist_name,
                "id": self.playlist_id
            }, f)
    
    def get_auth_url(self):
        """Generate Spotify authorization URL."""
        params = {
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "show_dialog": "false"
        }
        return f"https://accounts.spotify.com/authorize?{urlencode(params)}"
    
    def exchange_code(self, code):
        """Exchange authorization code for access token."""
        auth_header = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()
        ).decode()
        
        response = requests.post(
            "https://accounts.spotify.com/api/token",
            headers={"Authorization": f"Basic {auth_header}"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI
            }
        )
        
        if response.status_code == 200:
            data = response.json()
            self.access_token = data["access_token"]
            self.refresh_token = data.get("refresh_token")
            self.token_expiry = time.time() + data["expires_in"] - 60
            self.save_token()
            return True
        return False
    
    def refresh_access_token(self):
        """Refresh the access token using refresh token."""
        if not self.refresh_token:
            return False
        
        auth_header = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()
        ).decode()
        
        response = requests.post(
            "https://accounts.spotify.com/api/token",
            headers={"Authorization": f"Basic {auth_header}"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token
            }
        )
        
        if response.status_code == 200:
            data = response.json()
            self.access_token = data["access_token"]
            if "refresh_token" in data:
                self.refresh_token = data["refresh_token"]
            self.token_expiry = time.time() + data["expires_in"] - 60
            self.save_token()
            return True
        return False
    
    def ensure_authenticated(self):
        """Ensure we have a valid access token."""
        if self.load_cached_token():
            if time.time() < self.token_expiry:
                return True
            if self.refresh_access_token():
                return True
        
        print("\n🔐 Opening browser for Spotify authorization...")
        auth_url = self.get_auth_url()
        webbrowser.open(auth_url)
        
        server = HTTPServer(("localhost", 8888), OAuthCallbackHandler)
        server.auth_code = None
        server.handle_request()
        
        if server.auth_code:
            if self.exchange_code(server.auth_code):
                print("✅ Authorization successful!\n")
                return True
        
        print("❌ Authorization failed")
        return False
    
    def api_request(self, method, endpoint, **kwargs):
        """Make authenticated API request."""
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {self.access_token}"
        
        response = requests.request(
            method,
            f"https://api.spotify.com/v1{endpoint}",
            headers=headers,
            **kwargs
        )
        return response
    
    def get_user_id(self):
        """Get the current user's Spotify ID."""
        if self.user_id:
            return self.user_id
        
        response = self.api_request("GET", "/me")
        if response.status_code == 200:
            self.user_id = response.json()["id"]
            return self.user_id
        return None
    
    def find_playlist(self):
        """Find existing playlist by name."""
        if self.load_playlist_cache():
            # Verify it still exists
            response = self.api_request("GET", f"/playlists/{self.playlist_id}")
            if response.status_code == 200:
                return self.playlist_id
        
        # Search through user's playlists
        offset = 0
        while True:
            response = self.api_request(
                "GET", "/me/playlists",
                params={"limit": 50, "offset": offset}
            )
            if response.status_code != 200:
                break
            
            data = response.json()
            for playlist in data["items"]:
                if playlist["name"] == self.playlist_name:
                    self.playlist_id = playlist["id"]
                    self.save_playlist_cache()
                    return self.playlist_id
            
            if not data["next"]:
                break
            offset += 50
        
        return None
    
    def create_playlist(self):
        """Create a new playlist."""
        user_id = self.get_user_id()
        if not user_id:
            return None
        
        today = datetime.now().strftime("%B %d")
        response = self.api_request(
            "POST",
            f"/users/{user_id}/playlists",
            json={
                "name": self.playlist_name,
                "description": f"Daily podcast episodes, updated {today}. Auto-generated.",
                "public": False
            }
        )
        
        if response.status_code == 201:
            self.playlist_id = response.json()["id"]
            self.save_playlist_cache()
            return self.playlist_id
        return None
    
    def get_or_create_playlist(self):
        """Get existing playlist or create a new one."""
        playlist_id = self.find_playlist()
        if playlist_id:
            return playlist_id
        return self.create_playlist()
    
    def get_playlist_episodes(self):
        """Get all episode URIs currently in the playlist."""
        if not self.playlist_id:
            return []
        
        episodes = []
        offset = 0
        
        while True:
            response = self.api_request(
                "GET",
                f"/playlists/{self.playlist_id}/tracks",
                params={"limit": 100, "offset": offset}
            )
            if response.status_code != 200:
                break
            
            data = response.json()
            for item in data["items"]:
                if item["track"]:
                    episodes.append(item["track"]["uri"])
            
            if not data["next"]:
                break
            offset += 100
        
        return episodes
    
    def clear_playlist(self):
        """Remove all episodes from the playlist."""
        episodes = self.get_playlist_episodes()
        if not episodes:
            return True
        
        # Spotify allows removing up to 100 tracks at a time
        for i in range(0, len(episodes), 100):
            batch = episodes[i:i+100]
            response = self.api_request(
                "DELETE",
                f"/playlists/{self.playlist_id}/tracks",
                json={"tracks": [{"uri": uri} for uri in batch]}
            )
            if response.status_code != 200:
                return False
        
        return True
    
    def add_episodes_to_playlist(self, episode_uris):
        """Add episodes to the playlist."""
        if not episode_uris:
            return True
        
        # Spotify allows adding up to 100 tracks at a time
        for i in range(0, len(episode_uris), 100):
            batch = episode_uris[i:i+100]
            response = self.api_request(
                "POST",
                f"/playlists/{self.playlist_id}/tracks",
                json={"uris": batch}
            )
            if response.status_code != 201:
                return False
        
        return True
    
    def update_playlist_description(self):
        """Update playlist description with current date."""
        today = datetime.now().strftime("%B %d, %Y at %I:%M %p")
        self.api_request(
            "PUT",
            f"/playlists/{self.playlist_id}",
            json={
                "description": f"Daily podcast episodes. Last updated: {today}"
            }
        )
    
    def set_playlist_cover(self, image_path):
        """Upload a custom cover image for the playlist."""
        if not image_path:
            return False
        
        try:
            with open(image_path, "rb") as f:
                image_data = f.read()
            
            # Check file size (max 256KB)
            if len(image_data) > 256 * 1024:
                print(f"   ⚠️  Cover image too large ({len(image_data) // 1024}KB > 256KB)")
                return False
            
            image_b64 = base64.b64encode(image_data).decode()
            
            response = requests.put(
                f"https://api.spotify.com/v1/playlists/{self.playlist_id}/images",
                headers={
                    "Authorization": f"Bearer {self.access_token}",
                    "Content-Type": "image/jpeg"
                },
                data=image_b64
            )
            
            return response.status_code == 202
        except FileNotFoundError:
            print(f"   ⚠️  Cover image not found: {image_path}")
            return False
        except Exception as e:
            print(f"   ⚠️  Error setting cover: {e}")
            return False
    
    def get_recent_episodes(self, show_id, days=1):
        """Get episodes from the last N days."""
        cutoff = datetime.now() - timedelta(days=days)
        episodes = []
        
        response = self.api_request(
            "GET",
            f"/shows/{show_id}/episodes",
            params={"limit": 10, "market": "US"}
        )
        
        if response.status_code == 200:
            data = response.json()
            for episode in data["items"]:
                # Parse release date
                release_date = episode["release_date"]
                try:
                    if len(release_date) == 10:  # YYYY-MM-DD
                        ep_date = datetime.strptime(release_date, "%Y-%m-%d")
                    else:  # YYYY
                        ep_date = datetime.strptime(release_date, "%Y")
                    
                    if ep_date >= cutoff:
                        episodes.append({
                            "uri": episode["uri"],
                            "name": episode["name"],
                            "duration_ms": episode["duration_ms"],
                            "release_date": release_date
                        })
                except ValueError:
                    continue
        
        return episodes
    
    def update_daily_playlist(self, days=1, keep_old=False):
        """Main function to update the daily podcast playlist."""
        print("🎧 Daily Podcast Playlist")
        print("=" * 50)
        
        # Get or create playlist
        print(f"\n📋 Playlist: {self.playlist_name}")
        playlist_id = self.get_or_create_playlist()
        if not playlist_id:
            print("   ❌ Failed to create/find playlist")
            return False
        
        # Set custom cover if configured
        if PLAYLIST_COVER_IMAGE:
            print("   🖼️  Setting cover image...")
            if self.set_playlist_cover(PLAYLIST_COVER_IMAGE):
                print("   ✅ Cover updated!")
        
        existing_episodes = set(self.get_playlist_episodes()) if keep_old else set()
        
        if not keep_old:
            print("   🧹 Clearing old episodes...")
            self.clear_playlist()
        
        # Collect new episodes
        all_episodes = []
        
        for podcast in PODCASTS:
            print(f"\n🔍 {podcast['name']}...")
            
            episodes = self.get_recent_episodes(podcast["show_id"], days)
            if episodes:
                for ep in episodes:
                    if ep["uri"] not in existing_episodes:
                        duration_min = ep["duration_ms"] // 60000
                        print(f"   📅 {ep['release_date']} - {ep['name'][:40]}{'...' if len(ep['name']) > 40 else ''} ({duration_min}m)")
                        all_episodes.append(ep)
                    else:
                        print(f"   ⏭️  Already in playlist: {ep['name'][:40]}...")
            else:
                print(f"   ℹ️  No episodes in the last {days} day(s)")
        
        # Add episodes to playlist (newest first for each show, but shows in order)
        if all_episodes:
            print(f"\n📥 Adding {len(all_episodes)} episode(s) to playlist...")
            episode_uris = [ep["uri"] for ep in all_episodes]
            
            if self.add_episodes_to_playlist(episode_uris):
                print("   ✅ Episodes added!")
            else:
                print("   ❌ Failed to add some episodes")
        
        # Update description
        self.update_playlist_description()
        
        # Summary
        total_duration = sum(ep["duration_ms"] for ep in all_episodes) // 60000
        print(f"\n{'=' * 50}")
        print(f"✨ Playlist updated: {len(all_episodes)} new episodes ({total_duration} min)")
        print(f"🔗 Open in Spotify: https://open.spotify.com/playlist/{self.playlist_id}")
        
        return True


def main():
    parser = argparse.ArgumentParser(
        description="Update your daily podcast playlist on Spotify"
    )
    parser.add_argument(
        "--days", "-d",
        type=int,
        default=1,
        help="Include episodes from the last N days (default: 1)"
    )
    parser.add_argument(
        "--keep-old", "-k",
        action="store_true",
        help="Don't remove old episodes, just add new ones"
    )
    parser.add_argument(
        "--playlist", "-p",
        type=str,
        default="Daily Podcasts",
        help="Playlist name (default: 'Daily Podcasts')"
    )
    
    args = parser.parse_args()
    
    spotify = SpotifyDailyPodcasts(playlist_name=args.playlist)
    
    if not spotify.ensure_authenticated():
        sys.exit(1)
    
    spotify.update_daily_playlist(days=args.days, keep_old=args.keep_old)


if __name__ == "__main__":
    main()