// backend/src/etsy.js
// Etsy OAuth 2.0 + PKCE flow and API helper

import crypto from "crypto";

const ETSY_CLIENT_ID = (process.env.ETSY_CLIENT_ID || "").trim();
const ETSY_CLIENT_SECRET = (process.env.ETSY_CLIENT_SECRET || "").trim();
const ETSY_REDIRECT_URI = (process.env.ETSY_REDIRECT_URI || "http://localhost:4000/api/oauth/callback").trim();
const ETSY_AUTH_URL = "https://www.etsy.com/oauth/connect";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_API_BASE = "https://openapi.etsy.com/v3";

// PKCE: generate code verifier + challenge
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// In-memory PKCE store (cleared after use)
const pendingAuth = {};

/**
 * Build the Etsy OAuth authorization URL
 */
export function buildAuthUrl() {
  if (!ETSY_CLIENT_ID) throw new Error("ETSY_CLIENT_ID not configured");

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  // Store verifier for callback
  pendingAuth[state] = { verifier, createdAt: Date.now() };

  // Clean old entries (older than 10 min)
  for (const [k, v] of Object.entries(pendingAuth)) {
    if (Date.now() - v.createdAt > 600000) delete pendingAuth[k];
  }

  const scopes = [
    "shops_r",
    "listings_r",
    "listings_w",
    "transactions_r",
    "profile_r",
  ];

  const params = new URLSearchParams({
    response_type: "code",
    client_id: ETSY_CLIENT_ID,
    redirect_uri: ETSY_REDIRECT_URI,
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return { url: `${ETSY_AUTH_URL}?${params.toString()}`, state };
}

/**
 * Exchange authorization code for access + refresh tokens
 */
export async function exchangeCode(code, state) {
  const pending = pendingAuth[state];
  if (!pending) throw new Error("Invalid or expired state parameter");

  const verifier = pending.verifier;
  delete pendingAuth[state];

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ETSY_CLIENT_ID,
    redirect_uri: ETSY_REDIRECT_URI,
    code,
    code_verifier: verifier,
  });

  const res = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in, // seconds
    etsyUserId: String(data.token_type === "Bearer" ? "" : ""),
  };
}

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ETSY_CLIENT_ID,
    refresh_token: refreshToken,
  });

  const res = await fetch(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Make an authenticated Etsy API request
 * Handles token refresh automatically
 */
export async function etsyFetch(prisma, path, options = {}) {
  const token = await prisma.etsyToken.findUnique({ where: { id: "default" } });
  if (!token) throw new Error("Not connected to Etsy — please authenticate first");

  let accessToken = token.accessToken;

  // Refresh if expired (with 60s buffer)
  if (new Date() >= new Date(token.expiresAt.getTime() - 60000)) {
    try {
      const refreshed = await refreshAccessToken(token.refreshToken);
      accessToken = refreshed.accessToken;
      await prisma.etsyToken.update({
        where: { id: "default" },
        data: {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        },
      });
    } catch (err) {
      throw new Error("Etsy token refresh failed — please re-authenticate: " + err.message);
    }
  }

  const url = `${ETSY_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": ETSY_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Etsy API error (${res.status}): ${text.slice(0, 500)}`);
  }

  return res.json();
}

export { ETSY_CLIENT_ID, ETSY_REDIRECT_URI };
