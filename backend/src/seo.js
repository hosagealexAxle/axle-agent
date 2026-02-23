// backend/src/seo.js
// SEO optimization engine — keyword research, title/tag/description generation
// Works standalone (manual input) and auto-mode (pulls from Etsy API)

import { agentThink } from "./agent.js";

/**
 * Generate optimized Etsy listing SEO (title, tags, description)
 * @param {object} listing - { title, description, category, tags, priceUsd }
 * @returns {object} - { title, tags, description, keywords, score, suggestions }
 */
export async function optimizeListing(listing) {
  const prompt = `You are an expert Etsy SEO specialist. Optimize this listing for maximum Etsy search visibility.

Current listing:
- Title: ${listing.title || "Not provided"}
- Description: ${listing.description || "Not provided"}
- Category: ${listing.category || "Not specified"}
- Current tags: ${(listing.tags || []).join(", ") || "None"}
- Price: $${listing.priceUsd || "?"}

Rules:
- Title: max 140 chars, front-load best keywords, natural readable phrasing
- Tags: exactly 13 tags (Etsy max), multi-word long-tail keywords, no single words, no repeating words from title
- Description: first 160 chars are critical (shown in search), include primary keyword naturally
- Keywords: identify 5-8 high-value search terms buyers would use

Output ONLY valid JSON:
{
  "title": "optimized title here",
  "tags": ["tag1", "tag2", ... 13 total],
  "description": "optimized first paragraph (2-3 sentences)",
  "keywords": ["keyword1", "keyword2", ...],
  "score": 1-100,
  "suggestions": ["suggestion 1", "suggestion 2", ...]
}`;

  const response = await agentThink(
    "You are an Etsy SEO expert. Output ONLY valid JSON, no markdown.",
    prompt
  );

  try {
    return JSON.parse(response);
  } catch {
    return { raw: response, error: "Failed to parse SEO response" };
  }
}

/**
 * Keyword research for a product category
 */
export async function researchKeywords(category, productType) {
  const prompt = `Research Etsy search keywords for this product:
Category: ${category}
Product type: ${productType}

Provide:
1. Top 20 high-volume search terms buyers use
2. 10 long-tail keywords (3+ words) with lower competition
3. 5 trending/seasonal keywords
4. Competitor keywords to target

Output ONLY valid JSON:
{
  "highVolume": ["term1", "term2", ...],
  "longTail": ["long tail 1", "long tail 2", ...],
  "trending": ["trend1", "trend2", ...],
  "competitor": ["comp1", "comp2", ...],
  "summary": "brief strategy summary"
}`;

  const response = await agentThink(
    "You are an Etsy keyword research expert. Output ONLY valid JSON, no markdown.",
    prompt
  );

  try {
    return JSON.parse(response);
  } catch {
    return { raw: response, error: "Failed to parse keyword research" };
  }
}

/**
 * Batch audit multiple listings and rank by SEO improvement potential
 */
export async function auditListings(listings) {
  const listingSummary = listings.slice(0, 15).map((l, i) =>
    `${i + 1}. "${l.title}" — tags: ${(l.tags || []).length}/13, price: $${l.priceUsd || "?"}, visits: ${l.visits || "?"}, orders: ${l.orders || "?"}`
  ).join("\n");

  const prompt = `Audit these Etsy listings for SEO improvement potential. Rank them by which would benefit MOST from optimization.

Listings:
${listingSummary}

For each listing, score current SEO (1-100) and estimate traffic increase from optimization.

Output ONLY valid JSON:
{
  "rankings": [
    {
      "index": 1,
      "currentScore": 45,
      "potentialScore": 85,
      "estimatedTrafficIncrease": "30-50%",
      "topIssue": "title not keyword-optimized",
      "priority": "high"
    },
    ...
  ],
  "overallStrategy": "brief recommendation"
}`;

  const response = await agentThink(
    "You are an Etsy SEO auditor. Output ONLY valid JSON, no markdown.",
    prompt
  );

  try {
    return JSON.parse(response);
  } catch {
    return { raw: response, error: "Failed to parse audit" };
  }
}
