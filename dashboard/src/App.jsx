import React, { useEffect, useMemo, useRef, useState } from "react";
import "./index.css";

const API_BASE = "http://localhost:4000";

function nowTs() { return Date.now(); }
function fmtTime(ts) { try { return new Date(ts).toLocaleString(); } catch { return ""; } }

export default function App() {
  const [backendOk, setBackendOk] = useState(false);
  const [mode, setMode] = useState("chat");
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState("default");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastActions, setLastActions] = useState([]);
  const [budget, setBudget] = useState(null);
  const [shopStats, setShopStats] = useState(null);
  const [editingThreadId, setEditingThreadId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const chatRef = useRef(null);

  async function refreshHealth() {
    try {
      const r = await fetch(`${API_BASE}/api/health`);
      const j = await r.json();
      setBackendOk(Boolean(j.ok));
    } catch { setBackendOk(false); }
  }

  async function loadBudget() {
    try {
      const r = await fetch(`${API_BASE}/api/budget/summary`);
      const j = await r.json();
      if (j.ok) setBudget(j);
    } catch { /* ignore */ }
  }

  async function loadShopStats() {
    try {
      const r = await fetch(`${API_BASE}/api/shop/snapshot`);
      const j = await r.json();
      if (j.ok && j.snapshot) setShopStats(j.snapshot);
    } catch { /* ignore */ }
  }

  async function loadThreads() {
    try {
      const r = await fetch(`${API_BASE}/api/threads`);
      const j = await r.json();
      if (j.ok) {
        setThreads(j.threads || []);
        if (!(j.threads || []).some((t) => t.id === "default")) {
          setThreads((prev) => [{ id: "default", title: "Axle (Local)" }, ...prev]);
        }
      }
    } catch { /* ignore */ }
  }

  async function loadThread(threadId) {
    try {
      const r = await fetch(`${API_BASE}/api/chat/thread?threadId=${encodeURIComponent(threadId)}`);
      const j = await r.json();
      if (j.ok) setMessages(j.messages || []);
    } catch (e) {
      setMessages([{ role: "assistant", content: `⚠️ Error: ${e?.message || "Failed to load thread"}`, ts: nowTs() }]);
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
    } catch { /* ignore */ }
  }

  async function renameThread(id, title) {
    try {
      await fetch(`${API_BASE}/api/threads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      await loadThreads();
    } catch { /* ignore */ }
    setEditingThreadId(null);
  }

  async function deleteThread(id) {
    if (id === "default") return;
    try {
      await fetch(`${API_BASE}/api/threads/${id}`, { method: "DELETE" });
      await loadThreads();
      if (activeThreadId === id) setActiveThreadId("default");
    } catch { /* ignore */ }
  }

  async function loadActions() {
    try {
      const r = await fetch(`${API_BASE}/api/actions?take=5`);
      const j = await r.json();
      if (j.ok) setLastActions(j.rows || []);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    refreshHealth();
    loadThreads();
    loadThread(activeThreadId);
    loadBudget();
    loadShopStats();
    loadActions();
    const t = setInterval(() => { refreshHealth(); loadBudget(); loadActions(); }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadThread(activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

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
      setMessages((m) => [...m, { role: "assistant", content: j.reply || "", ts: nowTs() }]);
      loadThreads();
      loadBudget();
      loadActions();
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ Error: ${e?.message || "Failed to fetch"}`, ts: nowTs() }]);
    } finally {
      setBusy(false);
    }
  }

  const activeThreadTitle = useMemo(() => {
    const t = threads.find((x) => x.id === activeThreadId);
    return t?.title || "Axle (Local)";
  }, [threads, activeThreadId]);

  // Budget bar helper
  function BudgetBar({ label, spent, cap, color }) {
    const pct = cap > 0 ? Math.min((spent / cap) * 100, 100) : 0;
    const warn = pct > 80;
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3, color: "var(--muted)" }}>
          <span>{label}</span>
          <span style={{ color: warn ? "#ff6b6b" : "var(--muted)" }}>${spent} / ${cap}</span>
        </div>
        <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: pct + "%", borderRadius: 4, background: warn ? "#ff6b6b" : color || "rgba(90,120,255,0.7)", transition: "width 0.3s" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="brand">
          <div className="brandName">Axle</div>
          <div className="brandSub">Local operator console • Etsy API pending</div>
        </div>
        <button className="btn primary" onClick={createThread}>+ New chat</button>
        <div className="threadList">
          {threads.map((t) => (
            <div
              key={t.id}
              className={"threadItem " + (t.id === activeThreadId ? "active" : "")}
              onClick={() => { setActiveThreadId(t.id); setEditingThreadId(null); }}
            >
              {editingThreadId === t.id ? (
                <input
                  className="threadRenameInput"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameThread(t.id, editTitle);
                    if (e.key === "Escape") setEditingThreadId(null);
                  }}
                  onBlur={() => renameThread(t.id, editTitle)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div className="threadTitle">{t.title || t.id}</div>
                  <div className="threadActions">
                    <button
                      className="threadBtn"
                      title="Rename"
                      onClick={(e) => { e.stopPropagation(); setEditingThreadId(t.id); setEditTitle(t.title || ""); }}
                    >✏️</button>
                    {t.id !== "default" && (
                      <button
                        className="threadBtn"
                        title="Delete"
                        onClick={(e) => { e.stopPropagation(); if (confirm("Delete this thread?")) deleteThread(t.id); }}
                      >🗑️</button>
                    )}
                  </div>
                </>
              )}
            </div>
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
                Hey — I'm Axle. Etsy API is pending, so I'm running in planning + safety mode.
                <br /><br />
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
                <div className="meta">{m.role} • {fmtTime(m.ts || nowTs())}</div>
              </div>
            ))
          )}
          {busy && (
            <div className="bubble assistant">
              <div className="text thinking">…thinking</div>
            </div>
          )}
        </div>
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Axle… (Shift+Enter for new line)"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <button className="btn primary" onClick={send} disabled={!backendOk || busy}>Send</button>
        </div>
      </div>

      <div className="right">
        <div className="panel">
          <div className="panelTitle">System</div>
          <div className="kv"><div>Backend</div><div className={backendOk ? "ok" : "bad"}>{backendOk ? "Online" : "Offline"}</div></div>
          <div className="kv"><div>Thread</div><div>{activeThreadId}</div></div>
          <div className="kv"><div>Mode</div><div>{mode}</div></div>

          {/* Budget Spend Tracker */}
          <div className="sectionTitle" style={{ marginTop: 12 }}>Budget — Month to Date</div>
          {budget ? (
            <>
              <BudgetBar label="Total" spent={budget.monthToDate?.total || 0} cap={budget.caps?.total || 300} color="rgba(90,120,255,0.7)" />
              <BudgetBar label="API" spent={budget.monthToDate?.byCat?.api || 0} cap={budget.caps?.api || 200} color="rgba(0,200,150,0.7)" />
              <BudgetBar label="SEO" spent={budget.monthToDate?.byCat?.seo || 0} cap={budget.caps?.seo || 100} color="rgba(255,180,0,0.7)" />
              <BudgetBar label="Ads" spent={budget.monthToDate?.byCat?.ads || 0} cap={budget.caps?.ads || 150} color="rgba(200,100,255,0.7)" />
            </>
          ) : (
            <div className="mini">Loading budget…</div>
          )}

          {/* Shop Stats */}
          {shopStats && (
            <>
              <div className="sectionTitle" style={{ marginTop: 12 }}>Shop Stats</div>
              <div className="kv"><div>Visits</div><div>{shopStats.visits ?? "—"}</div></div>
              <div className="kv"><div>Orders</div><div>{shopStats.orders ?? "—"}</div></div>
              <div className="kv"><div>Revenue</div><div>${shopStats.revenueUsd ?? "—"}</div></div>
              <div className="kv"><div>CVR</div><div>{shopStats.conversionRate ?? "—"}%</div></div>
            </>
          )}

          {/* Recent Actions */}
          <div className="sectionTitle" style={{ marginTop: 12 }}>Recent Actions</div>
          {lastActions.length > 0 ? (
            <div className="actionList">
              {lastActions.map((a, i) => (
                <div key={i} className={"actionItem " + (a.ok ? "ok" : "fail")}>
                  <span className="actionType">[{a.type}]</span> {a.label}
                </div>
              ))}
            </div>
          ) : (
            <div className="mini">No recent actions</div>
          )}

          {/* Quick Commands */}
          <div className="sectionTitle" style={{ marginTop: 12 }}>Quick commands</div>
          <div className="quick">
            <button className="btn" onClick={() => setInput("/budget")}>/budget</button>
            <button className="btn" onClick={() => setInput("toggle ads")}>toggle ads</button>
            <button className="btn" onClick={() => setInput("kill switch on")}>kill switch on</button>
            <button className="btn" onClick={() => setInput("Plan my SEO today")}>Plan my SEO</button>
          </div>
        </div>
      </div>
    </div>
  );
}
