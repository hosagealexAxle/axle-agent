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
// Model should be one you have access to
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4.1-mini");
// If you ever use a proxy later:
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");

const SYSTEM_PROMPT =
  "You are Axle, an Etsy shop operator assistant. Etsy API is pending. " +
  "Focus on planning, UI guidance, and safety/budget control. " +
  "If asked for actions requiring Etsy API, propose a safe manual plan.";

// ======= helpers =======
function startOfDayISO(d = new Date()) {
  const dt = new Date(d);
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
  // You can later add month-to-date tracking by category;
  // for now we expose the configured caps + policy knobs.
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
      // placeholder (you can wire real spend later)
      monthToDate: { total: 0, byCat: { api: 0, seo: 0, ads: 0 } },
      today: { byCat: { api: 0, seo: 0, ads: 0 } },
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

// Thread list (persistent memory)
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

// Create thread
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

// Load a thread’s messages (compat endpoint your UI was already pointing at)
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

// Chat endpoint (writes to DB => persistent memory)
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

    // If no key => safe mode response, still persist assistant reply.
    if (!OPENAI_API_KEY) {
      const reply =
        `Axle (planning mode): You said "${body.message}". ` +
        "Etsy API is pending so I’m operating in safe mode.";
      await prisma.message.create({
        data: {
          threadId: thread.id,
          role: "assistant",
          content: reply,
        },
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

    const inputMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...recent.map((m) => ({ role: m.role, content: m.content })),
    ];

    // Call OpenAI Chat Completions (simple + stable)
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
        max_tokens: 350,
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

    return res.json({
      ok: true,
      mode: "chat",
      reply,
      actions: [],
    });
  } catch (e) {
    console.error("/api/chat error:", e);
    return safeJson(res, 400, { ok: false, error: "invalid_request" });
  }
});

app.listen(PORT, () => {
  console.log(`Axle backend running: http://localhost:${PORT}`);
});
