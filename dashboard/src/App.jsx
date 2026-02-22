import React, { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";

const API_BASE = "http://localhost:4000";

function nowTs() {
  return Date.now();
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

export default function App() {
  const [backendOk, setBackendOk] = useState(false);
  const [mode, setMode] = useState("chat");

  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState("default");

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const [lastActions, setLastActions] = useState([]);

  const chatRef = useRef(null);

  async function refreshHealth() {
    try {
      const r = await fetch(`${API_BASE}/api/health`);
      const j = await r.json();
      setBackendOk(Boolean(j.ok));
    } catch {
      setBackendOk(false);
    }
  }

  async function loadThreads() {
    try {
      const r = await fetch(`${API_BASE}/api/threads`);
      const j = await r.json();
      if (j.ok) {
        setThreads(j.threads || []);
        // Ensure default is always visible in UI
        if (!(j.threads || []).some((t) => t.id === "default")) {
          setThreads((prev) => [{ id: "default", title: "Axle (Local)" }, ...prev]);
        }
      }
    } catch {
      // ignore
    }
  }

  async function loadThread(threadId) {
    try {
      const r = await fetch(
        `${API_BASE}/api/chat/thread?threadId=${encodeURIComponent(threadId)}`
      );
      const j = await r.json();
      if (j.ok) setMessages(j.messages || []);
    } catch (e) {
      setMessages([
        {
          role: "assistant",
          content: `⚠️ Error: ${e?.message || "Failed to load thread"}`,
          ts: nowTs(),
        },
      ]);
    }
  }

  async function createThread() {
    try {
      const r = await fetch(`${API_BASE}/api/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New chat" }),
      });
      const j = await r.json();
      if (j.ok && j.thread?.id) {
        await loadThreads();
        setActiveThreadId(j.thread.id);
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refreshHealth();
    loadThreads();
    loadThread(activeThreadId);

    const t = setInterval(refreshHealth, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadThread(activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  // auto-scroll
  useEffect(() => {
    if (!chatRef.current) return;
    chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    setInput("");

    const optimistic = { role: "user", content: text, ts: nowTs() };
    setMessages((m) => [...m, optimistic]);

    try {
      const r = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: activeThreadId, message: text }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "chat failed");

      setMode(j.mode || "chat");
      setLastActions(j.actions || []);

      const assistant = {
        role: "assistant",
        content: j.reply || "",
        ts: nowTs(),
      };
      setMessages((m) => [...m, assistant]);

      // Refresh thread list so updatedAt order changes after chat
      loadThreads();
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `⚠️ Error: ${e?.message || "Failed to fetch"}`,
          ts: nowTs(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const activeThreadTitle = useMemo(() => {
    const t = threads.find((x) => x.id === activeThreadId);
    return t?.title || "Axle (Local)";
  }, [threads, activeThreadId]);

  return (
    <div className="app">
      <div className="sidebar">
        <div className="brand">
          <div className="brandName">Axle</div>
          <div className="brandSub">Local operator console • Etsy API pending</div>
        </div>

        <button className="btn primary" onClick={createThread}>
          + New chat
        </button>

        <div className="threadList">
          {threads.map((t) => (
            <button
              key={t.id}
              className={"threadItem " + (t.id === activeThreadId ? "active" : "")}
              onClick={() => setActiveThreadId(t.id)}
            >
              <div className="threadTitle">{t.title || t.id}</div>
              <div className="threadMeta">id: {t.id}</div>
            </button>
          ))}
        </div>

        <div className="footerStatus">
          <div>Backend: {backendOk ? "✅ Online" : "❌ Offline"}</div>
          <div>API: {API_BASE}</div>
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <div className="title">{activeThreadTitle}</div>
          <div className="mode">Mode: {mode}</div>
        </div>

        <div className="chat" ref={chatRef}>
          {messages.length === 0 ? (
            <div className="bubble assistant">
              <div className="text">
                Hey — I’m Axle. Etsy API is pending, so I’m running in planning + safety mode.
                <br />
                <br />
                Try:
                <ul>
                  <li>"Plan my SEO today"</li>
                  <li>"/budget"</li>
                  <li>"toggle ads"</li>
                </ul>
              </div>
              <div className="meta">assistant • {fmtTime(nowTs())}</div>
            </div>
          ) : (
            messages.map((m, idx) => (
              <div key={idx} className={"bubble " + (m.role === "user" ? "user" : "assistant")}>
                <div className="text">{m.content}</div>
                <div className="meta">
                  {m.role} • {fmtTime(m.ts || nowTs())}
                </div>
              </div>
            ))
          )}

          {busy && (
            <div className="bubble assistant">
              <div className="text">…thinking</div>
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Axle… (Shift+Enter for new line)"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn primary" onClick={send} disabled={!backendOk || busy}>
            Send
          </button>
        </div>
      </div>

      <div className="right">
        <div className="panel">
          <div className="panelTitle">System</div>

          <div className="kv">
            <div>Backend</div>
            <div className={backendOk ? "ok" : "bad"}>{backendOk ? "Online" : "Offline"}</div>
          </div>
          <div className="kv">
            <div>Thread</div>
            <div>{activeThreadId}</div>
          </div>
          <div className="kv">
            <div>Mode</div>
            <div>{mode}</div>
          </div>

          <div className="sectionTitle">Actions (last)</div>
          <pre className="code">{JSON.stringify(lastActions, null, 2)}</pre>

          <div className="sectionTitle" style={{ marginTop: 8 }}>
            Quick commands
          </div>
          <div className="quick">
            <button className="btn" onClick={() => setInput("/budget")}>
              /budget
            </button>
            <button className="btn" onClick={() => setInput("toggle ads")}>
              toggle ads
            </button>
            <button className="btn" onClick={() => setInput("kill switch on")}>
              kill switch on
            </button>
            <button className="btn" onClick={() => setInput("Plan my SEO today")}>
              Plan my SEO today
            </button>
          </div>

          <div className="mini" style={{ marginTop: "auto" }}>
            Next: we’ll add LLM calls behind budget caps (hybrid), then wrap in Electron (desktop).
          </div>
        </div>
      </div>
    </div>
  );
}
