// backend/src/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
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
// ======= OpenAI =======
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4.1-mini");
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");

// ======= Dynamic System Prompt (rebalanced) =======
const BASE_PROMPT = `You are Axle, an Etsy shop operator assistant. Your PRIMARY job is to respond helpfully to the user's message. Etsy API is pending approval.

IMPORTANT: Always address the user's question or request FIRST. Then, only if relevant, reference your memory data below. Do NOT dump data unless asked.

Guidelines:
- Be conversational and direct
- When asked for actions requiring Etsy API, propose a safe manual plan
- Enforce budget caps — warn if approaching limits
- Reference key facts naturally, don't list them unless asked`;

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
  res.json({ ok: true, ts: new Date().toISOString() });
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
    // If no key => safe mode response
    if (!OPENAI_API_KEY) {
      const reply =
        `Axle (planning mode): You said "${body.message}". ` +
        "Etsy API is pending so I'm operating in safe mode.";
      await prisma.message.create({
        data: { threadId: thread.id, role: "assistant", content: reply },
      });
      await bumpThreadUpdatedAt(thread.id);
      await logAction({ type: "chat", label: "safe_mode_reply", detail: reply, ok: true });
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
    const inputMessages = [
      { role: "system", content: systemPrompt },
      ...recent.map((m) => ({ role: m.role, content: m.content })),
    ];
    // Call OpenAI Chat Completions
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
      const reply = "I hit an error talking to the model. Try again.";
      await prisma.message.create({
        data: { threadId: thread.id, role: "assistant", content: reply },
      });
      await bumpThreadUpdatedAt(thread.id);
      await logAction({ type: "chat", label: "openai_error", detail: text.slice(0, 800), ok: false });
      return safeJson(res, 500, { ok: false, error: "openai_failed", detail: text.slice(0, 400) });
    }
    const data = await r.json();
    const reply =
      (data?.choices?.[0]?.message?.content && String(data.choices[0].message.content).trim()) ||
      "I did not get a text response back.";
    // Persist assistant reply
    await prisma.message.create({
      data: { threadId: thread.id, role: "assistant", content: reply },
    });
    await bumpThreadUpdatedAt(thread.id);
    await logAction({ type: "chat", label: "reply", detail: reply.slice(0, 500), ok: true });
    return res.json({ ok: true, mode: "chat", reply, actions: [] });
  } catch (e) {
    console.error("/api/chat error:", e);
    return safeJson(res, 400, { ok: false, error: "invalid_request" });
  }
});

app.listen(PORT, () => {
  console.log(`Axle backend running: http://localhost:${PORT}`);
});
