/**
 * Daily Podcasts for Spotify - Cloudflare Worker
 * 
 * Creates and maintains Spotify playlists with latest podcast episodes.
 * Runs daily via cron trigger, supports multiple users.
 */

import { DEFAULT_COVER_IMAGE } from "./cover.js";

// Spotify credentials come from the environment:
//   SPOTIFY_CLIENT_ID     -> [vars] in wrangler.toml
//   SPOTIFY_CLIENT_SECRET -> `npx wrangler secret put SPOTIFY_CLIENT_SECRET`
// The OAuth redirect URI is derived from the incoming request URL.
function redirectUri(url) {
  return `${url.origin}/callback`;
}

const SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private", 
  "playlist-read-private",
  "ugc-image-upload"
].join(" ");

// Default podcasts - users can customize via /config endpoint
const DEFAULT_PODCASTS = [
  { name: "FT News Briefing", show_id: "1410RabA4XOqO6IV8p0gYF" },
  { name: "Up First from NPR", show_id: "2mTUnDkuKUkhiueKcVWoP0" },
  { name: "The Daily", show_id: "3IM0lmZxpFAY7CwMuv9H4g" }
];




export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case "/":
        return handleHome();
      case "/auth":
        return handleAuth(url, env);
      case "/callback":
        return handleCallback(url, env);
      case "/status":
        return handleStatus(url, env);
      case "/update":
        return handleManualUpdate(url, env);
      case "/config":
        return handleConfig(request, url, env);
      case "/settings":
        return handleSettings(url, env);
      case "/api/podcasts":
        return handlePodcastsApi(request, url, env);
      default:
        return new Response("Not found", { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateAllUsers(env));
  }
};

// =============================================================================
// Route Handlers
// =============================================================================

function handleHome() {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Daily Pods for Spotify</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      margin: 0;
      padding: 2rem;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .container {
      max-width: 480px;
      text-align: center;
    }
    h1 { 
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #888;
      margin-bottom: 2rem;
    }
    .btn {
      display: inline-block;
      background: #1DB954;
      color: #fff;
      padding: 1rem 2rem;
      border-radius: 50px;
      text-decoration: none;
      font-weight: 600;
      transition: transform 0.2s, background 0.2s;
    }
    .btn:hover {
      background: #1ed760;
      transform: scale(1.05);
    }
    .info {
      margin-top: 2rem;
      padding: 1rem;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      font-size: 0.9rem;
      color: #aaa;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎧 Daily Pods</h1>
    <p class="subtitle">Auto-queue your daily podcasts to a Spotify playlist</p>
    <a href="/auth" class="btn">Connect Spotify</a>
    <div class="info">
      Your playlist updates automatically every morning with the latest episodes 
      from your favorite daily podcasts.
    </div>
  </div>
</body>
</html>`;
  
  return new Response(html, {
    headers: { "Content-Type": "text/html" }
  });
}

function handleAuth(url, env) {
  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(url),
    scope: SCOPES,
    show_dialog: "true"
  });
  
  return Response.redirect(
    `https://accounts.spotify.com/authorize?${params.toString()}`,
    302
  );
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  
  if (error || !code) {
    return new Response(`Authorization failed: ${error || "No code received"}`, { 
      status: 400 
    });
  }
  
  // Exchange code for tokens
  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(url)
    })
  });
  
  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    return new Response(`Token exchange failed: ${err}`, { status: 400 });
  }
  
  const tokens = await tokenResponse.json();
  
  // Get user profile
  const profileResponse = await fetch("https://api.spotify.com/v1/me", {
    headers: { "Authorization": `Bearer ${tokens.access_token}` }
  });
  
  if (!profileResponse.ok) {
    return new Response("Failed to get user profile", { status: 400 });
  }
  
  const profile = await profileResponse.json();
  
  // Store user data in KV
  const userData = {
    id: profile.id,
    display_name: profile.display_name,
    refresh_token: tokens.refresh_token,
    podcasts: DEFAULT_PODCASTS,
    playlist_id: null,
    created_at: new Date().toISOString(),
    last_updated: null
  };
  
  await env.USERS.put(`user:${profile.id}`, JSON.stringify(userData));
  
  // Run initial playlist update
  const spotify = new SpotifyClient(tokens.access_token, tokens.refresh_token, env);
  const result = await updateUserPlaylist(spotify, userData, env);
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Connected!</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #1DB954, #191414);
      color: #fff;
      min-height: 100vh;
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 3rem; margin-bottom: 0.5rem; }
    a { color: #fff; }
    .btn {
      display: inline-block;
      background: rgba(255,255,255,0.2);
      color: #fff;
      padding: 0.75rem 1.5rem;
      border-radius: 50px;
      text-decoration: none;
      margin: 0.5rem;
      transition: background 0.2s;
    }
    .btn:hover { background: rgba(255,255,255,0.3); }
  </style>
</head>
<body>
  <div class="container">
    <h1>✅</h1>
    <h2>You're all set, ${profile.display_name || profile.id}!</h2>
    <p>Your "Daily Pods" playlist has been created and will update every morning.</p>
    <p>
      ${result.playlist_id ? `<a class="btn" href="https://open.spotify.com/playlist/${result.playlist_id}" target="_blank">Open Playlist</a>` : ''}
      <a class="btn" href="/settings?user=${profile.id}">Customize Podcasts</a>
    </p>
  </div>
</body>
</html>`;
  
  return new Response(html, {
    headers: { "Content-Type": "text/html" }
  });
}

async function handleStatus(url, env) {
  const userId = url.searchParams.get("user");
  
  if (userId) {
    const userData = await env.USERS.get(`user:${userId}`, "json");
    if (!userData) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }
    return Response.json({
      id: userData.id,
      display_name: userData.display_name,
      playlist_id: userData.playlist_id,
      podcasts: userData.podcasts,
      last_updated: userData.last_updated
    });
  }
  
  // List all users
  const list = await env.USERS.list({ prefix: "user:" });
  const users = [];
  
  for (const key of list.keys) {
    const userData = await env.USERS.get(key.name, "json");
    users.push({
      id: userData.id,
      display_name: userData.display_name,
      last_updated: userData.last_updated
    });
  }
  
  return Response.json({ users, count: users.length });
}

async function handleManualUpdate(url, env) {
  const userId = url.searchParams.get("user");

  try {
    if (userId) {
      const userData = await env.USERS.get(`user:${userId}`, "json");
      if (!userData) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const spotify = await SpotifyClient.fromRefreshToken(userData.refresh_token, env);
      const result = await updateUserPlaylist(spotify, userData, env);
      return Response.json(result);
    }

    // Update all users
    const results = await updateAllUsers(env);
    return Response.json(results);
  } catch (e) {
    return Response.json({
      success: false,
      error: e.message || "Update failed"
    }, { status: 500 });
  }
}

async function handleConfig(request, url, env) {
  const userId = url.searchParams.get("user");
  
  if (!userId) {
    return Response.json({ error: "Missing user parameter" }, { status: 400 });
  }
  
  const userData = await env.USERS.get(`user:${userId}`, "json");
  if (!userData) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }
  
  if (request.method === "GET") {
    return Response.json({ podcasts: userData.podcasts });
  }
  
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (Array.isArray(body.podcasts)) {
        userData.podcasts = body.podcasts;
        await env.USERS.put(`user:${userId}`, JSON.stringify(userData));
        return Response.json({ success: true, podcasts: userData.podcasts });
      }
    } catch (e) {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }
  
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

async function handleSettings(url, env) {
  const userId = url.searchParams.get("user");
  
  if (!userId) {
    return new Response("Missing user parameter. Use /settings?user=YOUR_SPOTIFY_ID", { 
      status: 400 
    });
  }
  
  const userData = await env.USERS.get(`user:${userId}`, "json");
  if (!userData) {
    return new Response("User not found. Please connect your Spotify account first at /", { 
      status: 404 
    });
  }
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Settings - Daily Pods</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      margin: 0;
      padding: 2rem;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    h1 { margin-bottom: 0.25rem; }
    .subtitle { color: #888; margin-bottom: 2rem; }
    .card {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .card h2 {
      margin: 0 0 1rem 0;
      font-size: 1.1rem;
      color: #1DB954;
    }
    .podcast-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .podcast-item:last-child { border-bottom: none; }
    .podcast-name { font-weight: 500; }
    .podcast-id { font-size: 0.8rem; color: #666; font-family: monospace; }
    .btn {
      background: #1DB954;
      color: #fff;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.2s;
    }
    .btn:hover { background: #1ed760; }
    .btn-danger { background: #e74c3c; }
    .btn-danger:hover { background: #c0392b; }
    .btn-secondary { background: #444; }
    .btn-secondary:hover { background: #555; }
    input[type="text"] {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 6px;
      background: rgba(0,0,0,0.3);
      color: #fff;
      font-size: 1rem;
      margin-bottom: 0.5rem;
    }
    input[type="text"]::placeholder { color: #666; }
    input[type="text"]:focus {
      outline: none;
      border-color: #1DB954;
    }
    .add-form { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .add-form input { flex: 1; min-width: 200px; margin: 0; }
    .message {
      padding: 0.75rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      display: none;
    }
    .message.success { background: rgba(29, 185, 84, 0.2); display: block; }
    .message.error { background: rgba(231, 76, 60, 0.2); display: block; }
    .empty { color: #666; font-style: italic; }
    .playlist-link {
      display: inline-block;
      margin-top: 1rem;
      color: #1DB954;
      text-decoration: none;
    }
    .playlist-link:hover { text-decoration: underline; }
    .help {
      font-size: 0.85rem;
      color: #888;
      margin-top: 0.5rem;
    }
    .cover-preview {
      width: 80px;
      height: 80px;
      border-radius: 8px;
      margin-bottom: 1rem;
    }
    .btn.loading {
      opacity: 0.7;
      pointer-events: none;
    }
    .btn.loading::after {
      content: '';
      display: inline-block;
      width: 12px;
      height: 12px;
      margin-left: 8px;
      border: 2px solid #fff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .last-updated {
      font-size: 0.85rem;
      color: #888;
      margin-top: 0.5rem;
    }
    .next-update {
      font-size: 0.85rem;
      color: #888;
      margin-top: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>⚙️ Settings</h1>
    <p class="subtitle">Manage your daily podcasts, ${userData.display_name || userId}</p>
    <img src="data:image/jpeg;base64,${DEFAULT_COVER_IMAGE}" class="cover-preview" alt="Playlist cover">

    <div id="message" class="message"></div>
    
    <div class="card">
      <h2>Your Podcasts</h2>
      <div id="podcast-list">
        ${userData.podcasts.length === 0 
          ? '<p class="empty">No podcasts added yet</p>' 
          : userData.podcasts.map((p, i) => `
            <div class="podcast-item" data-index="${i}">
              <div>
                <div class="podcast-name">${escapeHtml(p.name)}</div>
                <div class="podcast-id">${p.show_id}</div>
              </div>
              <button class="btn btn-danger" onclick="removePodcast(${i})">Remove</button>
            </div>
          `).join('')}
      </div>
    </div>
    
    <div class="card">
      <h2>Add Podcast</h2>
      <div class="add-form">
        <input type="text" id="podcast-url" placeholder="Paste Spotify podcast URL or show ID">
        <button class="btn" onclick="addPodcast()">Add</button>
      </div>
      <p class="help">
        To get the URL: Open podcast in Spotify → ⋯ → Share → Copy link to show
      </p>
    </div>
    
    <div class="card">
      <h2>Actions</h2>
      <button id="update-btn" class="btn btn-secondary" onclick="updateNow()">Update Playlist Now</button>
      ${userData.playlist_id
        ? `<a class="playlist-link" href="https://open.spotify.com/playlist/${userData.playlist_id}" target="_blank">Open Playlist →</a>`
        : ''}
      ${userData.last_updated
        ? `<p class="last-updated">Last updated: ${new Date(userData.last_updated).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(',', '')} (EST)</p>`
        : '<p class="last-updated">Not yet updated</p>'}
      <p class="next-update">Next update: <span id="next-update-time"></span> in <span id="countdown"></span></p>
    </div>
  </div>
  
  <script>
    const userId = "${userId}";
    let podcasts = ${JSON.stringify(userData.podcasts)};
    
    function showMessage(text, isError = false) {
      const el = document.getElementById('message');
      el.textContent = text;
      el.className = 'message ' + (isError ? 'error' : 'success');
      setTimeout(() => el.className = 'message', 3000);
    }
    
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
    
    function renderPodcasts() {
      const list = document.getElementById('podcast-list');
      if (podcasts.length === 0) {
        list.innerHTML = '<p class="empty">No podcasts added yet</p>';
        return;
      }
      list.innerHTML = podcasts.map((p, i) => \`
        <div class="podcast-item" data-index="\${i}">
          <div>
            <div class="podcast-name">\${escapeHtml(p.name)}</div>
            <div class="podcast-id">\${p.show_id}</div>
          </div>
          <button class="btn btn-danger" onclick="removePodcast(\${i})">Remove</button>
        </div>
      \`).join('');
    }
    
    async function savePodcasts() {
      const response = await fetch('/api/podcasts?user=' + userId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ podcasts })
      });
      return response.ok;
    }
    
    async function addPodcast() {
      const input = document.getElementById('podcast-url');
      const value = input.value.trim();
      
      if (!value) return;
      
      // Extract show ID from URL or use as-is
      let showId = value;
      const match = value.match(/show\\/([a-zA-Z0-9]+)/);
      if (match) showId = match[1];
      
      // Check if already added
      if (podcasts.some(p => p.show_id === showId)) {
        showMessage('Podcast already in your list', true);
        return;
      }
      
      // Fetch podcast info from Spotify
      try {
        const response = await fetch('/api/podcasts?user=' + userId + '&lookup=' + showId);
        const data = await response.json();
        
        if (data.error) {
          showMessage(data.error, true);
          return;
        }
        
        podcasts.push({ name: data.name, show_id: showId });
        await savePodcasts();
        renderPodcasts();
        input.value = '';
        showMessage('Added: ' + data.name);
      } catch (e) {
        showMessage('Failed to add podcast', true);
      }
    }
    
    async function removePodcast(index) {
      const name = podcasts[index].name;
      podcasts.splice(index, 1);
      await savePodcasts();
      renderPodcasts();
      showMessage('Removed: ' + name);
    }
    
    async function updateNow() {
      const btn = document.getElementById('update-btn');
      btn.classList.add('loading');
      btn.textContent = 'Updating...';
      showMessage('Updating playlist...');
      try {
        const response = await fetch('/update?user=' + userId);
        const data = await response.json();
        if (data.success) {
          showMessage('Playlist updated! ' + data.episodes_added + ' episodes added.');
          const lastUpdated = document.querySelector('.last-updated');
          if (lastUpdated) {
            lastUpdated.textContent = 'Last updated: ' + new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(',', '') + ' (EST)';
          }
        } else {
          showMessage('Update failed: ' + data.error, true);
        }
      } catch (e) {
        showMessage('Update failed: ' + e.message, true);
      } finally {
        btn.classList.remove('loading');
        btn.textContent = 'Update Playlist Now';
      }
    }
    
    // Allow Enter key to add
    document.getElementById('podcast-url').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') addPodcast();
    });

    // Countdown to next update
    function updateCountdown() {
      const now = new Date();
      // Get next 7am EST (12pm UTC)
      let next = new Date(now);
      next.setUTCHours(12, 0, 0, 0);
      if (now >= next) {
        next.setUTCDate(next.getUTCDate() + 1);
      }

      // Format next update time in EST
      const nextTimeStr = next.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(',', '') + ' (EST)';
      document.getElementById('next-update-time').textContent = nextTimeStr;

      // Calculate countdown
      const diff = next - now;
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const secs = Math.floor((diff % (1000 * 60)) / 1000);
      document.getElementById('countdown').textContent =
        String(hours).padStart(2, '0') + ':' +
        String(mins).padStart(2, '0') + ':' +
        String(secs).padStart(2, '0');
    }

    updateCountdown();
    setInterval(updateCountdown, 1000);
  </script>
</body>
</html>`;
  
  return new Response(html, {
    headers: { "Content-Type": "text/html" }
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function handlePodcastsApi(request, url, env) {
  const userId = url.searchParams.get("user");
  
  if (!userId) {
    return Response.json({ error: "Missing user parameter" }, { status: 400 });
  }
  
  const userData = await env.USERS.get(`user:${userId}`, "json");
  if (!userData) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }
  
  // Lookup a podcast by show ID
  const lookupId = url.searchParams.get("lookup");
  if (lookupId && request.method === "GET") {
    try {
      const spotify = await SpotifyClient.fromRefreshToken(userData.refresh_token, env);
      const show = await spotify.api("GET", `/shows/${lookupId}?market=US`);
      return Response.json({ name: show.name, show_id: lookupId });
    } catch (e) {
      return Response.json({ error: "Podcast not found" }, { status: 404 });
    }
  }
  
  // Get podcasts
  if (request.method === "GET") {
    return Response.json({ podcasts: userData.podcasts });
  }
  
  // Update podcasts
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (Array.isArray(body.podcasts)) {
        userData.podcasts = body.podcasts;
        await env.USERS.put(`user:${userId}`, JSON.stringify(userData));
        return Response.json({ success: true });
      }
    } catch (e) {
      return Response.json({ error: "Invalid request" }, { status: 400 });
    }
  }
  
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

// =============================================================================
// Spotify API Client
// =============================================================================

class SpotifyClient {
  constructor(accessToken, refreshToken, env) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.env = env;
  }
  
  static async fromRefreshToken(refreshToken, env) {
    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });
    
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${await response.text()}`);
    }

    const text = await response.text();
    if (!text) {
      throw new Error("Token refresh failed: empty response");
    }
    const tokens = JSON.parse(text);
    return new SpotifyClient(
      tokens.access_token,
      tokens.refresh_token || refreshToken,
      env
    );
  }
  
  async api(method, endpoint, body = null) {
    const options = {
      method,
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      }
    };
    
    if (body) {
      options.body = JSON.stringify(body);
    }
    
    const response = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
    
    if (response.status === 204) {
      return null;
    }
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Spotify API error: ${response.status} ${error}`);
    }

    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  }
  
  async getMe() {
    return this.api("GET", "/me");
  }
  
  async findPlaylist(name) {
    let offset = 0;
    
    while (true) {
      const data = await this.api("GET", `/me/playlists?limit=50&offset=${offset}`);
      
      for (const playlist of data.items) {
        if (playlist.name === name) {
          return playlist.id;
        }
      }
      
      if (!data.next) break;
      offset += 50;
    }
    
    return null;
  }
  
  async createPlaylist(userId, name) {
    const today = new Date().toLocaleDateString("en-US", { 
      month: "long", 
      day: "numeric" 
    });
    
    const data = await this.api("POST", `/users/${userId}/playlists`, {
      name,
      description: `Daily podcast episodes, updated ${today}. Auto-generated.`,
      public: false
    });
    
    return data.id;
  }
  
  async getPlaylistTracks(playlistId) {
    const tracks = [];
    let offset = 0;
    
    while (true) {
      const data = await this.api(
        "GET", 
        `/playlists/${playlistId}/tracks?limit=100&offset=${offset}`
      );
      
      for (const item of data.items) {
        if (item.track) {
          tracks.push(item.track.uri);
        }
      }
      
      if (!data.next) break;
      offset += 100;
    }
    
    return tracks;
  }
  
  async clearPlaylist(playlistId) {
    const tracks = await this.getPlaylistTracks(playlistId);
    
    for (let i = 0; i < tracks.length; i += 100) {
      const batch = tracks.slice(i, i + 100);
      await this.api("DELETE", `/playlists/${playlistId}/tracks`, {
        tracks: batch.map(uri => ({ uri }))
      });
    }
  }
  
  async addToPlaylist(playlistId, uris) {
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      await this.api("POST", `/playlists/${playlistId}/tracks`, { uris: batch });
    }
  }
  
  async updatePlaylistDescription(playlistId) {
    const now = new Date().toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
    
    await this.api("PUT", `/playlists/${playlistId}`, {
      description: `Daily podcast episodes. Last updated: ${now}`
    });
  }

  async setPlaylistImage(playlistId, base64Image) {
    await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/images`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type": "image/jpeg"
      },
      body: base64Image
    });
  }

  async getRecentEpisodes(showId, days = 1) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    
    const episodes = [];
    
    try {
      const data = await this.api("GET", `/shows/${showId}/episodes?limit=10&market=US`);
      
      for (const episode of data.items) {
        const releaseDate = new Date(episode.release_date);
        
        if (releaseDate >= cutoff) {
          episodes.push({
            uri: episode.uri,
            name: episode.name,
            duration_ms: episode.duration_ms,
            release_date: episode.release_date
          });
        }
      }
    } catch (e) {
      console.error(`Error fetching episodes for ${showId}:`, e);
    }
    
    return episodes;
  }
}

// =============================================================================
// Playlist Update Logic
// =============================================================================

async function updateUserPlaylist(spotify, userData, env) {
  const playlistName = "Daily Pods";
  const log = [];
  
  try {
    // Get user ID
    const me = await spotify.getMe();
    log.push(`Updating playlist for ${me.display_name || me.id}`);
    
    // Find or create playlist
    let playlistId = userData.playlist_id;
    
    if (playlistId) {
      // Verify it still exists
      try {
        await spotify.api("GET", `/playlists/${playlistId}`);
      } catch (e) {
        playlistId = null;
      }
    }
    
    if (!playlistId) {
      playlistId = await spotify.findPlaylist(playlistName);
    }
    
    if (!playlistId) {
      playlistId = await spotify.createPlaylist(me.id, playlistName);
      log.push(`Created new playlist: ${playlistId}`);
    }
    
    // Update cached playlist ID
    userData.playlist_id = playlistId;

    // Set cover image
    if (DEFAULT_COVER_IMAGE) {
      try {
        await spotify.setPlaylistImage(playlistId, DEFAULT_COVER_IMAGE);
        log.push("Set cover image");
      } catch (e) {
        log.push(`Cover image failed: ${e.message}`);
      }
    }

    // Clear existing episodes
    await spotify.clearPlaylist(playlistId);
    log.push("Cleared old episodes");
    
    // Fetch new episodes
    const allEpisodes = [];
    
    for (const podcast of userData.podcasts) {
      const episodes = await spotify.getRecentEpisodes(podcast.show_id, 1);
      log.push(`${podcast.name}: ${episodes.length} episode(s)`);
      allEpisodes.push(...episodes);
    }
    
    // Add episodes to playlist
    if (allEpisodes.length > 0) {
      const uris = allEpisodes.map(ep => ep.uri);
      await spotify.addToPlaylist(playlistId, uris);
      log.push(`Added ${allEpisodes.length} episodes`);
    }
    
    // Update description
    await spotify.updatePlaylistDescription(playlistId);
    
    // Save updated user data
    userData.last_updated = new Date().toISOString();
    userData.refresh_token = spotify.refreshToken;
    await env.USERS.put(`user:${userData.id}`, JSON.stringify(userData));
    
    return {
      success: true,
      user: userData.id,
      playlist_id: playlistId,
      episodes_added: allEpisodes.length,
      log
    };
    
  } catch (e) {
    log.push(`Error: ${e.message}`);
    return {
      success: false,
      user: userData.id,
      error: e.message,
      log
    };
  }
}

async function updateAllUsers(env) {
  const results = [];
  const list = await env.USERS.list({ prefix: "user:" });
  
  console.log(`Starting daily update for ${list.keys.length} users`);
  
  for (const key of list.keys) {
    const userData = await env.USERS.get(key.name, "json");
    
    try {
      const spotify = await SpotifyClient.fromRefreshToken(userData.refresh_token, env);
      const result = await updateUserPlaylist(spotify, userData, env);
      results.push(result);
      console.log(`✅ ${userData.id}: ${result.episodes_added} episodes`);
    } catch (e) {
      results.push({
        success: false,
        user: userData.id,
        error: e.message
      });
      console.log(`❌ ${userData.id}: ${e.message}`);
    }
  }
  
  return {
    updated_at: new Date().toISOString(),
    total_users: list.keys.length,
    results
  };
}
