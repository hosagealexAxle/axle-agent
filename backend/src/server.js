// backend/src/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { buildAuthUrl, exchangeCode, etsyFetch, ETSY_CLIENT_ID } from "./etsy.js";
import { startAgent, stopAgent, getAgentStatus } from "./agent.js";
dotenv.config();
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 4000);
// ======= Config / caps =======
const CAP_TOTAL_USD = Number(process.env.CAP_TOTAL_USD || 300);
const CAP_API_USD = Number(process.env.CAP_API_USD || 200);
const CAP_SEO_USD = Number(process.env.CAP_SEO_USD || 100);
const CAP_ADS_USD = Number(process.env.CAP_ADS_USD || 150);
const DAILY_CAP_API_USD = Number(process.env.DAILY_CAP_API_USD || 50);
const DAILY_CAP_SEO_USD = Number(process.env.DAILY_CAP_SEO_USD || 50);
const DAILY_CAP_ADS_USD = Number(process.env.DAILY_CAP_ADS_USD || 50);
const POLICY_MODE = String(process.env.POLICY_MODE || "aggressive");
const OVERRUN_MAX_USD = Number(process.env.OVERRUN_MAX_USD || 50);
const ROI_MIN = Number(process.env.ROI_MIN || 2.0);
const RISK_MODE = String(process.env.RISK_MODE || "cashflow");
const CONFIDENCE_MIN = Number(process.env.CONFIDENCE_MIN || 0.85);
const APPROVAL_THRESHOLD_USD = Number(process.env.APPROVAL_THRESHOLD_USD || 25);
const KILL_SWITCH_DEFAULT =
  String(process.env.KILL_SWITCH || "false").toLowerCase() === "true";
// ======= LLM Config =======
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const ANTHROPIC_MODEL = String(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6");
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4.1-mini");
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
const USE_CLAUDE = !!ANTHROPIC_API_KEY;

// ======= Dynamic System Prompt (rebalanced) =======
const BASE_PROMPT = `You are Axle, an autonomous Etsy shop operator for MrsMillennialDesigns. You are powered by Claude (Anthropic).

Your job is to help the shop owner maximize revenue, optimize listings, and manage the shop efficiently. You operate semi-autonomously — take action without asking unless spending exceeds the approval threshold.

Core behaviors:
- Be direct, concise, and action-oriented
- Address the user's message FIRST, then reference data if relevant
- When you have enough data to act, propose specific actions with expected ROI
- Enforce budget caps — warn proactively if approaching limits
- Track what works and what doesn't — learn from results
- Reference key facts naturally, never dump data unless asked

Autonomous guidelines:
- SEO changes under $${String(process.env.APPROVAL_THRESHOLD_USD || 25)}: execute without asking
- Spending above approval threshold: present plan and wait for approval
- Kill switch ON: halt ALL automated actions immediately
- Always log actions so the owner can review what you did and why

When Etsy API is connected, you can directly manage listings, read sales data, and optimize the shop. Until then, provide actionable manual plans.`;

async function buildSystemPrompt() {
  let prompt = BASE_PROMPT;

  // Inject key facts (persistent memory)
  const facts = await prisma.keyFact.findMany({ orderBy: { updatedAt: "desc" }, take: 50 });
  if (facts.length > 0) {
    const grouped = {};
    for (const f of facts) {
      if (!grouped[f.category]) grouped[f.category] = [];
      grouped[f.category].push(f.content);
    }
    prompt += "\n\n== KEY FACTS (persistent memory — reference naturally, don't dump) ==";
    for (const [cat, items] of Object.entries(grouped)) {
      prompt += "\n[" + cat.toUpperCase() + "]";
      for (const item of items) prompt += "\n- " + item;
    }
  }

  // Inject budget state
  const policy = await getPolicySnapshot();
  prompt += "\n\n== BUDGET STATE ==";
  prompt += "\nCaps: total=$" + policy.caps.total + " api=$" + policy.caps.api + " seo=$" + policy.caps.seo + " ads=$" + policy.caps.ads;
  prompt += "\nMonth spend: total=$" + policy.spend.monthToDate.total + " (api=$" + policy.spend.monthToDate.byCat.api + " seo=$" + policy.spend.monthToDate.byCat.seo + " ads=$" + policy.spend.monthToDate.byCat.ads + ")";
  prompt += "\nToday spend: api=$" + policy.spend.today.byCat.api + " seo=$" + policy.spend.today.byCat.seo + " ads=$" + policy.spend.today.byCat.ads;
  prompt += "\nKill switch: " + (policy.killSwitch ? "ON — all actions blocked" : "off");

  // Inject latest shop snapshot
  const snap = await prisma.shopSnapshot.findFirst({ orderBy: { capturedAt: "desc" } });
  if (snap) {
    prompt += "\n\n== LATEST SHOP STATS ==";
    prompt += "\nVisits=" + (snap.visits ?? "?") + " Orders=" + (snap.orders ?? "?") + " Revenue=$" + (snap.revenueUsd ?? "?") + " CVR=" + (snap.conversionRate ?? "?") + "%";
    prompt += "\nPeriod: " + (snap.period || "unknown");
  }

  // Inject recent actions (compact)
  const actions = await prisma.actionLog.findMany({ orderBy: { createdAt: "desc" }, take: 5 });
  if (actions.length > 0) {
    prompt += "\n\n== RECENT ACTIONS (last 5) ==";
    for (const a of actions) {
      prompt += "\n- [" + (a.type || a.actionType || "?") + "] " + (a.label || a.status || "") + (a.detail || a.blockedReason ? ": " + (a.detail || a.blockedReason || "") : "");
    }
  }

  return prompt;
}

// ======= helpers =======
function startOfDayISO(d = new Date()) {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt.toISOString();
}
function startOfMonthISO(d = new Date()) {
  const dt = new Date(d);
  dt.setDate(1);
  dt.setHours(0, 0, 0, 0);
  return dt.toISOString();
}
async function ensureThread(threadId) {
  const id = threadId || "default";
  const existing = await prisma.thread.findUnique({ where: { id } });
  if (existing) return existing;
  return prisma.thread.create({
    data: {
      id,
      title: id === "default" ? "Axle (Local)" : `Thread ${id}`,
    },
  });
}
async function bumpThreadUpdatedAt(threadId) {
  await prisma.thread.update({
    where: { id: threadId },
    data: { updatedAt: new Date() },
  }).catch(() => {});
}
async function logAction({ type, label, detail, amountUsd, ok = true }) {
  try {
    await prisma.actionLog.create({
      data: {
        type: type || "info",
        label: label || "",
        detail: detail || "",
        amountUsd: amountUsd ?? null,
        ok,
      },
    });
  } catch {
    // non-fatal
  }
}
async function getPolicySnapshot() {
  const monthStart = startOfMonthISO();
  const dayStart = startOfDayISO();

  // Calculate real spend from BudgetLedger
  const monthRows = await prisma.budgetLedger.findMany({
    where: { createdAt: { gte: new Date(monthStart) } },
  });
  const todayRows = await prisma.budgetLedger.findMany({
    where: { createdAt: { gte: new Date(dayStart) } },
  });

  function sumByCat(rows) {
    const byCat = { api: 0, seo: 0, ads: 0 };
    let total = 0;
    for (const r of rows) {
      const cat = (r.category || "").toLowerCase();
      const amt = r.amountUsd || 0;
      total += amt;
      if (byCat[cat] !== undefined) byCat[cat] += amt;
    }
    return { total: Math.round(total * 100) / 100, byCat: {
      api: Math.round(byCat.api * 100) / 100,
      seo: Math.round(byCat.seo * 100) / 100,
      ads: Math.round(byCat.ads * 100) / 100,
    }};
  }

  return {
    mode: POLICY_MODE,
    overrunMaxUsd: OVERRUN_MAX_USD,
    roiMin: ROI_MIN,
    riskMode: RISK_MODE,
    confidenceMin: CONFIDENCE_MIN,
    approvalThresholdUsd: APPROVAL_THRESHOLD_USD,
    caps: {
      total: CAP_TOTAL_USD,
      api: CAP_API_USD,
      seo: CAP_SEO_USD,
      ads: CAP_ADS_USD,
    },
    dailyCaps: {
      api: DAILY_CAP_API_USD,
      seo: DAILY_CAP_SEO_USD,
      ads: DAILY_CAP_ADS_USD,
    },
    spend: {
      monthToDate: sumByCat(monthRows),
      today: sumByCat(todayRows),
    },
    killSwitch: KILL_SWITCH_DEFAULT,
  };
}
function safeJson(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.send(JSON.stringify(obj));
}
// ======= routes =======
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    llm: USE_CLAUDE ? `claude (${ANTHROPIC_MODEL})` : `openai (${OPENAI_MODEL})`,
  });
});
app.get("/api/policy", async (_req, res) => {
  const policy = await getPolicySnapshot();
  res.json({ ok: true, policy });
});

// ======= Budget summary (for dashboard chart) =======
app.get("/api/budget/summary", async (_req, res) => {
  try {
    const policy = await getPolicySnapshot();
    res.json({
      ok: true,
      caps: policy.caps,
      dailyCaps: policy.dailyCaps,
      monthToDate: policy.spend.monthToDate,
      today: policy.spend.today,
    });
  } catch (e) {
    console.error("GET /api/budget/summary error:", e);
    return safeJson(res, 500, { ok: false, error: "budget_summary_failed" });
  }
});

// ======= Threads =======
app.get("/api/threads", async (_req, res) => {
  try {
    const threads = await prisma.thread.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    res.json({ ok: true, threads });
  } catch (e) {
    console.error("GET /api/threads error:", e);
    return safeJson(res, 500, { ok: false, error: "threads_failed" });
  }
});

app.post("/api/threads", async (req, res) => {
  const body = z
    .object({
      id: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return safeJson(res, 400, { ok: false, error: "invalid_request" });
  try {
    const id = body.data.id || crypto.randomUUID();
    const title = body.data.title || "New chat";
    const thread = await prisma.thread.create({ data: { id, title } });
    res.json({ ok: true, thread });
  } catch (e) {
    console.error("POST /api/threads error:", e);
    return safeJson(res, 500, { ok: false, error: "thread_create_failed" });
  }
});

// Rename thread
app.patch("/api/threads/:id", async (req, res) => {
  const body = z.object({ title: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return safeJson(res, 400, { ok: false, error: "invalid_request" });
  try {
    const thread = await prisma.thread.update({
      where: { id: req.params.id },
      data: { title: body.data.title },
    });
    res.json({ ok: true, thread });
  } catch (e) {
    console.error("PATCH /api/threads error:", e);
    return safeJson(res, 500, { ok: false, error: "thread_rename_failed" });
  }
});

// Delete thread (cascade deletes messages)
app.delete("/api/threads/:id", async (req, res) => {
  try {
    await prisma.message.deleteMany({ where: { threadId: req.params.id } });
    await prisma.thread.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/threads error:", e);
    return safeJson(res, 500, { ok: false, error: "thread_delete_failed" });
  }
});

// Load a thread's messages
app.get("/api/chat/thread", async (req, res) => {
  const threadId = String(req.query.threadId || "default");
  try {
    await ensureThread(threadId);
    const messages = await prisma.message.findMany({
      where: { threadId },
      orderBy: { createdAt: "asc" },
      take: 400,
    });
    res.json({
      ok: true,
      threadId,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ts: m.createdAt.getTime(),
      })),
    });
  } catch (e) {
    console.error("GET /api/chat/thread error:", e);
    return safeJson(res, 500, { ok: false, error: "thread_load_failed" });
  }
});

// Action log (last N)
app.get("/api/actions", async (req, res) => {
  try {
    const take = Math.min(Number(req.query.take || 50), 200);
    const rows = await prisma.actionLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
    });
    res.json({
      ok: true,
      rows: rows.map((r) => ({
        type: r.type,
        label: r.label,
        detail: r.detail,
        amountUsd: r.amountUsd,
        ok: r.ok,
        ts: r.createdAt.getTime(),
      })),
    });
  } catch (e) {
    console.error("GET /api/actions error:", e);
    return safeJson(res, 500, { ok: false, error: "actions_failed" });
  }
});

// ======= Key Facts (persistent memory) =======
app.get("/api/keyfacts", async (req, res) => {
  try {
    const category = req.query.category;
    const where = category ? { category } : {};
    const facts = await prisma.keyFact.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    res.json({ ok: true, facts });
  } catch (e) {
    console.error("GET /api/keyfacts error:", e);
    return safeJson(res, 500, { ok: false, error: "keyfacts_failed" });
  }
});

app.post("/api/keyfacts", async (req, res) => {
  const body = z
    .object({
      category: z.enum(["preference", "strategy", "product", "rule", "note"]),
      content: z.string().min(1),
      source: z.enum(["user", "llm", "system"]).optional(),
      pinned: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return safeJson(res, 400, { ok: false, error: "invalid_request" });
  try {
    const fact = await prisma.keyFact.create({
      data: {
        category: body.data.category,
        content: body.data.content,
        source: body.data.source || "user",
        pinned: body.data.pinned || false,
      },
    });
    res.json({ ok: true, fact });
  } catch (e) {
    console.error("POST /api/keyfacts error:", e);
    return safeJson(res, 500, { ok: false, error: "keyfact_create_failed" });
  }
});

app.delete("/api/keyfacts/:id", async (req, res) => {
  try {
    await prisma.keyFact.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/keyfacts error:", e);
    return safeJson(res, 500, { ok: false, error: "keyfact_delete_failed" });
  }
});

// ======= Shop data endpoints =======
app.post("/api/shop/snapshot", async (req, res) => {
  try {
    const snap = await prisma.shopSnapshot.create({ data: req.body });
    res.json({ ok: true, snapshot: snap });
  } catch (e) {
    console.error("POST /api/shop/snapshot error:", e);
    return safeJson(res, 500, { ok: false, error: "snapshot_failed" });
  }
});

app.get("/api/shop/snapshot", async (_req, res) => {
  try {
    const snap = await prisma.shopSnapshot.findFirst({ orderBy: { capturedAt: "desc" } });
    res.json({ ok: true, snapshot: snap });
  } catch (e) {
    console.error("GET /api/shop/snapshot error:", e);
    return safeJson(res, 500, { ok: false, error: "snapshot_failed" });
  }
});

app.post("/api/listings/metric", async (req, res) => {
  try {
    const metric = await prisma.listingMetric.create({ data: req.body });
    res.json({ ok: true, metric });
  } catch (e) {
    console.error("POST /api/listings/metric error:", e);
    return safeJson(res, 500, { ok: false, error: "metric_failed" });
  }
});

app.post("/api/budget/log", async (req, res) => {
  try {
    const entry = await prisma.budgetLedger.create({ data: req.body });
    res.json({ ok: true, entry });
  } catch (e) {
    console.error("POST /api/budget/log error:", e);
    return safeJson(res, 500, { ok: false, error: "budget_log_failed" });
  }
});

// ======= Chat endpoint =======
app.post("/api/chat", async (req, res) => {
  try {
    const body = z
      .object({
        threadId: z.string().min(1),
        message: z.string().min(1),
      })
      .parse(req.body);
    const thread = await ensureThread(body.threadId);
    // Save user message
    await prisma.message.create({
      data: {
        threadId: thread.id,
        role: "user",
        content: body.message,
      },
    });
    await bumpThreadUpdatedAt(thread.id);
    // If no LLM key => safe mode response
    if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
      const reply =
        "Axle (offline): No LLM API key configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env.";
      await prisma.message.create({
        data: { threadId: thread.id, role: "assistant", content: reply },
      });
      await bumpThreadUpdatedAt(thread.id);
      return res.json({ ok: true, mode: "chat", reply, actions: [] });
    }
    // Pull recent conversation as context
    const recent = await prisma.message.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
      take: 40,
    });
    // Build dynamic system prompt with injected memory
    const systemPrompt = await buildSystemPrompt();

    let reply;
    const llmProvider = USE_CLAUDE ? "claude" : "openai";

    if (USE_CLAUDE) {
      // ======= Anthropic Claude Messages API =======
      const claudeMessages = recent.map((m) => ({ role: m.role, content: m.content }));
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages: claudeMessages,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error("Claude error:", r.status, text.slice(0, 800));
        const errReply = "I hit an error talking to Claude. Try again.";
        await prisma.message.create({
          data: { threadId: thread.id, role: "assistant", content: errReply },
        });
        await bumpThreadUpdatedAt(thread.id);
        await logAction({ type: "chat", label: "claude_error", detail: text.slice(0, 800), ok: false });
        return safeJson(res, 500, { ok: false, error: "claude_failed", detail: text.slice(0, 400) });
      }
      const data = await r.json();
      reply = (data?.content?.[0]?.text || "").trim() || "I did not get a response back.";
    } else {
      // ======= OpenAI Chat Completions (fallback) =======
      const inputMessages = [
        { role: "system", content: systemPrompt },
        ...recent.map((m) => ({ role: m.role, content: m.content })),
      ];
      const r = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: inputMessages,
          temperature: 0.6,
          max_tokens: 600,
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error("OpenAI error:", r.status, text.slice(0, 800));
        const errReply = "I hit an error talking to the model. Try again.";
        await prisma.message.create({
          data: { threadId: thread.id, role: "assistant", content: errReply },
        });
        await bumpThreadUpdatedAt(thread.id);
        await logAction({ type: "chat", label: "openai_error", detail: text.slice(0, 800), ok: false });
        return safeJson(res, 500, { ok: false, error: "openai_failed", detail: text.slice(0, 400) });
      }
      const data = await r.json();
      reply = (data?.choices?.[0]?.message?.content || "").trim() || "I did not get a response back.";
    }
    // Persist assistant reply
    await prisma.message.create({
      data: { threadId: thread.id, role: "assistant", content: reply },
    });
    await bumpThreadUpdatedAt(thread.id);
    await logAction({ type: "chat", label: `reply (${llmProvider})`, detail: reply.slice(0, 500), ok: true });
    return res.json({ ok: true, mode: "chat", reply, actions: [] });
  } catch (e) {
    console.error("/api/chat error:", e);
    return safeJson(res, 400, { ok: false, error: "invalid_request" });
  }
});

// ======= Etsy OAuth 2.0 + PKCE =======
app.get("/api/etsy/status", async (_req, res) => {
  try {
    const token = await prisma.etsyToken.findUnique({ where: { id: "default" } });
    const connected = !!(token && new Date() < new Date(token.expiresAt.getTime() + 90 * 24 * 3600 * 1000)); // refresh tokens last 90 days
    res.json({
      ok: true,
      connected,
      configured: !!ETSY_CLIENT_ID,
      shopId: token?.shopId || null,
      etsyUserId: token?.etsyUserId || null,
    });
  } catch (e) {
    console.error("GET /api/etsy/status error:", e);
    return safeJson(res, 500, { ok: false, error: "etsy_status_failed" });
  }
});

app.get("/api/oauth/authorize", (_req, res) => {
  try {
    const { url } = buildAuthUrl();
    res.json({ ok: true, url });
  } catch (e) {
    console.error("GET /api/oauth/authorize error:", e);
    return safeJson(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.send(`<html><body><h2>Authorization denied</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
  }
  if (!code || !state) {
    return res.send(`<html><body><h2>Missing code or state</h2><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
  }
  try {
    const tokens = await exchangeCode(String(code), String(state));
    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    // Get the user's shop ID
    let etsyUserId = null;
    let shopId = null;
    try {
      // Temporarily save token so etsyFetch works
      await prisma.etsyToken.upsert({
        where: { id: "default" },
        create: { id: "default", accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt },
        update: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt },
      });

      // Fetch user info
      const meRes = await fetch("https://openapi.etsy.com/v3/application/users/me", {
        headers: {
          "x-api-key": ETSY_CLIENT_ID,
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });
      if (meRes.ok) {
        const me = await meRes.json();
        etsyUserId = String(me.user_id || "");
        // Fetch shop
        if (etsyUserId) {
          const shopRes = await fetch(`https://openapi.etsy.com/v3/application/users/${etsyUserId}/shops`, {
            headers: {
              "x-api-key": ETSY_CLIENT_ID,
              Authorization: `Bearer ${tokens.accessToken}`,
            },
          });
          if (shopRes.ok) {
            const shopData = await shopRes.json();
            shopId = String(shopData.shop_id || "");
          }
        }
      }
    } catch (err) {
      console.warn("Could not fetch Etsy user/shop info:", err.message);
    }

    // Save tokens
    await prisma.etsyToken.upsert({
      where: { id: "default" },
      create: { id: "default", accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt, etsyUserId, shopId },
      update: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt, etsyUserId, shopId },
    });

    await logAction({ type: "etsy", label: "oauth_connected", detail: `Shop ${shopId || "unknown"} connected`, ok: true });

    res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0a0e13;color:#fff">
      <h2 style="color:#4ade80">Connected to Etsy!</h2>
      <p>You can close this window and return to Axle.</p>
      <script>setTimeout(()=>window.close(),3000)</script>
    </body></html>`);
  } catch (e) {
    console.error("OAuth callback error:", e);
    await logAction({ type: "etsy", label: "oauth_failed", detail: e.message, ok: false });
    res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0a0e13;color:#fff">
      <h2 style="color:#ff6b6b">Connection Failed</h2>
      <p>${e.message}</p>
      <script>setTimeout(()=>window.close(),5000)</script>
    </body></html>`);
  }
});

app.post("/api/oauth/disconnect", async (_req, res) => {
  try {
    await prisma.etsyToken.deleteMany();
    await logAction({ type: "etsy", label: "disconnected", detail: "Etsy account disconnected", ok: true });
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/oauth/disconnect error:", e);
    return safeJson(res, 500, { ok: false, error: "disconnect_failed" });
  }
});

// ======= Etsy API proxy endpoints =======
app.get("/api/etsy/shop", async (_req, res) => {
  try {
    const token = await prisma.etsyToken.findUnique({ where: { id: "default" } });
    if (!token?.shopId) return safeJson(res, 400, { ok: false, error: "no_shop_connected" });
    const shop = await etsyFetch(prisma, `/application/shops/${token.shopId}`);
    res.json({ ok: true, shop });
  } catch (e) {
    console.error("GET /api/etsy/shop error:", e);
    return safeJson(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/etsy/listings", async (req, res) => {
  try {
    const token = await prisma.etsyToken.findUnique({ where: { id: "default" } });
    if (!token?.shopId) return safeJson(res, 400, { ok: false, error: "no_shop_connected" });
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const offset = Number(req.query.offset || 0);
    const listings = await etsyFetch(prisma, `/application/shops/${token.shopId}/listings?limit=${limit}&offset=${offset}`);
    res.json({ ok: true, ...listings });
  } catch (e) {
    console.error("GET /api/etsy/listings error:", e);
    return safeJson(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/etsy/receipts", async (req, res) => {
  try {
    const token = await prisma.etsyToken.findUnique({ where: { id: "default" } });
    if (!token?.shopId) return safeJson(res, 400, { ok: false, error: "no_shop_connected" });
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const receipts = await etsyFetch(prisma, `/application/shops/${token.shopId}/receipts?limit=${limit}`);
    res.json({ ok: true, ...receipts });
  } catch (e) {
    console.error("GET /api/etsy/receipts error:", e);
    return safeJson(res, 500, { ok: false, error: e.message });
  }
});

// ======= Agent endpoints =======
app.get("/api/agent/status", async (_req, res) => {
  try {
    const status = await getAgentStatus(prisma);
    res.json({ ok: true, ...status });
  } catch (e) {
    console.error("GET /api/agent/status error:", e);
    return safeJson(res, 500, { ok: false, error: "agent_status_failed" });
  }
});

app.post("/api/agent/start", (_req, res) => {
  startAgent(prisma, logAction, 60000);
  res.json({ ok: true, message: "Agent started" });
});

app.post("/api/agent/stop", (_req, res) => {
  stopAgent();
  res.json({ ok: true, message: "Agent stopped" });
});

app.get("/api/agent/tasks", async (req, res) => {
  try {
    const status = req.query.status;
    const where = status ? { status } : {};
    const tasks = await prisma.agentTask.findMany({
      where,
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: 50,
    });
    res.json({ ok: true, tasks });
  } catch (e) {
    console.error("GET /api/agent/tasks error:", e);
    return safeJson(res, 500, { ok: false, error: "tasks_failed" });
  }
});

app.post("/api/agent/tasks", async (req, res) => {
  const body = z.object({
    type: z.enum(["seo_optimize", "listing_refresh", "ad_launch", "analysis", "custom"]),
    title: z.string().min(1),
    description: z.string().optional(),
    priority: z.number().min(1).max(10).optional(),
    estimatedCost: z.number().optional(),
    targetId: z.string().optional(),
    scheduledFor: z.string().optional(),
  }).safeParse(req.body);
  if (!body.success) return safeJson(res, 400, { ok: false, error: "invalid_request" });
  try {
    const estCost = body.data.estimatedCost || 0;
    const task = await prisma.agentTask.create({
      data: {
        type: body.data.type,
        title: body.data.title,
        description: body.data.description || "",
        priority: body.data.priority || 5,
        estimatedCost: estCost,
        targetId: body.data.targetId || null,
        scheduledFor: body.data.scheduledFor ? new Date(body.data.scheduledFor) : null,
        status: estCost > APPROVAL_THRESHOLD_USD ? "needs_approval" : "pending",
        autoApproved: estCost <= APPROVAL_THRESHOLD_USD,
      },
    });
    res.json({ ok: true, task });
  } catch (e) {
    console.error("POST /api/agent/tasks error:", e);
    return safeJson(res, 500, { ok: false, error: "task_create_failed" });
  }
});

app.post("/api/agent/tasks/:id/approve", async (req, res) => {
  try {
    const task = await prisma.agentTask.update({
      where: { id: req.params.id },
      data: { status: "approved" },
    });
    await logAction({ type: "agent", label: "task_approved", detail: task.title, ok: true });
    res.json({ ok: true, task });
  } catch (e) {
    console.error("POST /api/agent/tasks/:id/approve error:", e);
    return safeJson(res, 500, { ok: false, error: "approve_failed" });
  }
});

app.delete("/api/agent/tasks/:id", async (req, res) => {
  try {
    await prisma.agentTask.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/agent/tasks/:id error:", e);
    return safeJson(res, 500, { ok: false, error: "task_delete_failed" });
  }
});

// ======= ROI endpoints =======
app.get("/api/roi/summary", async (_req, res) => {
  try {
    const entries = await prisma.roiTracker.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const totalCost = entries.reduce((s, r) => s + (r.costUsd || 0), 0);
    const measured = entries.filter((r) => r.roiMultiple !== null);
    const totalRevChange = measured.reduce((s, r) => s + (r.revenueChange || 0), 0);
    const avgRoi = measured.length > 0
      ? measured.reduce((s, r) => s + (r.roiMultiple || 0), 0) / measured.length
      : null;
    res.json({
      ok: true,
      totalActions: entries.length,
      totalCost: Math.round(totalCost * 100) / 100,
      measuredActions: measured.length,
      totalRevenueChange: Math.round(totalRevChange * 100) / 100,
      averageRoi: avgRoi ? Math.round(avgRoi * 10) / 10 : null,
      entries: entries.slice(0, 20),
    });
  } catch (e) {
    console.error("GET /api/roi/summary error:", e);
    return safeJson(res, 500, { ok: false, error: "roi_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Axle backend running: http://localhost:${PORT}`);
  console.log(`LLM: ${USE_CLAUDE ? `Claude (${ANTHROPIC_MODEL})` : `OpenAI (${OPENAI_MODEL})`}`);
  // Only auto-start agent if Claude + Etsy are both configured
  if (USE_CLAUDE) {
    const token = await prisma.etsyToken.findFirst({ where: { id: "default" } }).catch(() => null);
    if (token?.accessToken) {
      startAgent(prisma, logAction, 60000);
      console.log("[boot] Agent auto-started (Etsy connected)");
    } else {
      console.log("[boot] Agent NOT started — connect Etsy first");
    }
  }
});
