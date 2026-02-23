// backend/src/pinterest.js
// Pinterest OAuth 2.0 flow and API helper
// Supports pin creation, board management, and ads API

import crypto from "crypto";

const PINTEREST_APP_ID = (process.env.PINTEREST_APP_ID || "").trim();
const PINTEREST_APP_SECRET = (process.env.PINTEREST_APP_SECRET || "").trim();
const PINTEREST_REDIRECT_URI = (process.env.PINTEREST_REDIRECT_URI || "http://localhost:4000/api/pinterest/callback").trim();
const PINTEREST_AUTH_URL = "https://www.pinterest.com/oauth/";
const PINTEREST_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token";
const PINTEREST_API_BASE = "https://api.pinterest.com/v5";

// In-memory OAuth state store
const pendingAuth = {};

/**
 * Build Pinterest OAuth authorization URL
 */
export function buildPinterestAuthUrl() {
  if (!PINTEREST_APP_ID) throw new Error("PINTEREST_APP_ID not configured");

  const state = crypto.randomBytes(16).toString("hex");
  pendingAuth[state] = { createdAt: Date.now() };

  // Clean old entries
  for (const [k, v] of Object.entries(pendingAuth)) {
    if (Date.now() - v.createdAt > 600000) delete pendingAuth[k];
  }

  const scopes = [
    "boards:read",
    "boards:write",
    "pins:read",
    "pins:write",
    "user_accounts:read",
  ];

  const params = new URLSearchParams({
    client_id: PINTEREST_APP_ID,
    redirect_uri: PINTEREST_REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(","),
    state,
  });

  return { url: `${PINTEREST_AUTH_URL}?${params.toString()}`, state };
}

/**
 * Validate OAuth state parameter
 */
export function validateState(state) {
  const pending = pendingAuth[state];
  if (!pending) return false;
  delete pendingAuth[state];
  return true;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangePinterestCode(code) {
  const credentials = Buffer.from(`${PINTEREST_APP_ID}:${PINTEREST_APP_SECRET}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: PINTEREST_REDIRECT_URI,
  });

  const res = await fetch(PINTEREST_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinterest token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    scope: data.scope,
  };
}

/**
 * Refresh Pinterest access token
 */
export async function refreshPinterestToken(refreshToken) {
  const credentials = Buffer.from(`${PINTEREST_APP_ID}:${PINTEREST_APP_SECRET}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(PINTEREST_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinterest token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Make an authenticated Pinterest API request with auto-refresh
 */
export async function pinterestFetch(prisma, path, options = {}) {
  const token = await prisma.pinterestToken.findUnique({ where: { id: "default" } });
  if (!token) throw new Error("Not connected to Pinterest — please authenticate first");

  let accessToken = token.accessToken;

  // Refresh if expired (60s buffer)
  if (new Date() >= new Date(token.expiresAt.getTime() - 60000)) {
    try {
      const refreshed = await refreshPinterestToken(token.refreshToken);
      accessToken = refreshed.accessToken;
      await prisma.pinterestToken.update({
        where: { id: "default" },
        data: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });
    } catch (err) {
      throw new Error("Pinterest token refresh failed — please re-authenticate: " + err.message);
    }
  }

  const url = `${PINTEREST_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pinterest API error (${res.status}): ${text.slice(0, 500)}`);
  }

  return res.json();
}

/**
 * Create a pin from an Etsy listing
 */
export async function createPinFromListing(prisma, { boardId, title, description, link, imageUrl }) {
  return pinterestFetch(prisma, "/pins", {
    method: "POST",
    body: JSON.stringify({
      board_id: boardId,
      title: title.slice(0, 100),
      description: description.slice(0, 500),
      link,
      media_source: {
        source_type: "image_url",
        url: imageUrl,
      },
    }),
  });
}

/**
 * Get user's boards
 */
export async function getBoards(prisma) {
  return pinterestFetch(prisma, "/boards");
}

/**
 * Create a new board
 */
export async function createBoard(prisma, { name, description }) {
  return pinterestFetch(prisma, "/boards", {
    method: "POST",
    body: JSON.stringify({
      name: name.slice(0, 50),
      description: (description || "").slice(0, 500),
      privacy: "PUBLIC",
    }),
  });
}

export { PINTEREST_APP_ID, PINTEREST_REDIRECT_URI };
