// backend/src/agent.js
// Autonomous agent engine — plans, queues, and executes tasks
// Only asks for approval when estimated cost exceeds APPROVAL_THRESHOLD_USD

const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || "").trim();
const ANTHROPIC_MODEL = String(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6");
const APPROVAL_THRESHOLD_USD = Number(process.env.APPROVAL_THRESHOLD_USD || 25);

let agentRunning = false;
let agentInterval = null;

/**
 * Call Claude for agent-level reasoning (cheaper model for routine tasks)
 */
async function agentThink(systemPrompt, userMessage) {
  if (!ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY configured");

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
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Claude agent error (${r.status}): ${text.slice(0, 500)}`);
  }

  const data = await r.json();
  return (data?.content?.[0]?.text || "").trim();
}

/**
 * Process a single agent task
 */
async function processTask(prisma, task, logAction) {
  // Mark as running
  await prisma.agentTask.update({
    where: { id: task.id },
    data: { status: "running", startedAt: new Date() },
  });

  try {
    let result;

    switch (task.type) {
      case "analysis": {
        // Run a shop analysis — skip if no data to avoid wasting tokens
        const snapshot = await prisma.shopSnapshot.findFirst({ orderBy: { capturedAt: "desc" } });
        const listings = await prisma.listingMetric.findMany({
          orderBy: { capturedAt: "desc" },
          take: 20,
        });
        const budget = await prisma.budgetLedger.findMany({
          where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
        });

        if (!snapshot && listings.length === 0) {
          result = { skipped: true, reason: "No shop data yet — connect Etsy and sync first" };
          break;
        }

        const analysisPrompt = `You are Axle's autonomous analysis agent. Analyze this shop data and provide 3-5 specific, actionable recommendations. Be concise.

Shop snapshot: ${JSON.stringify(snapshot || "No data yet")}
Recent listings (${listings.length}): ${JSON.stringify(listings.slice(0, 10))}
Monthly spend entries: ${budget.length}

Output a JSON array of recommendations: [{"action": "...", "type": "seo_optimize|listing_refresh|ad_launch", "priority": 1-10, "estimatedCost": 0.00, "targetId": "optional", "reason": "..."}]`;

        const response = await agentThink(
          "You are an Etsy shop optimization agent. Output ONLY valid JSON, no markdown.",
          analysisPrompt
        );

        // Try to parse recommendations and create sub-tasks
        try {
          const recs = JSON.parse(response);
          if (Array.isArray(recs)) {
            for (const rec of recs.slice(0, 5)) {
              const estCost = Number(rec.estimatedCost) || 0;
              await prisma.agentTask.create({
                data: {
                  type: rec.type || "custom",
                  title: rec.action || "Recommendation",
                  description: rec.reason || "",
                  priority: Number(rec.priority) || 5,
                  estimatedCost: estCost,
                  targetId: rec.targetId || null,
                  status: estCost > APPROVAL_THRESHOLD_USD ? "needs_approval" : "pending",
                  autoApproved: estCost <= APPROVAL_THRESHOLD_USD,
                },
              });
            }
          }
          result = { recommendations: recs.length, response };
        } catch {
          result = { raw: response };
        }
        break;
      }

      case "seo_optimize": {
        // Generate SEO suggestions for a listing
        const response = await agentThink(
          "You are an Etsy SEO expert. Provide optimized title, tags (13 max), and first paragraph of description. Output as JSON: {title, tags: [], description}",
          `Optimize this listing for Etsy search:\nTitle: ${task.title}\nDescription: ${task.description}\nTarget: ${task.targetId || "general"}`
        );
        result = { seoSuggestions: response };
        break;
      }

      case "listing_refresh": {
        const response = await agentThink(
          "You are an Etsy listing optimization agent. Suggest specific changes to refresh a stale listing. Output as JSON: {changes: [{field, before, after, reason}]}",
          `This listing needs refreshing:\nTitle: ${task.title}\nDetails: ${task.description}\nTarget ID: ${task.targetId || "unknown"}`
        );
        result = { refreshPlan: response };
        break;
      }

      case "pinterest_pin": {
        // Generate Pinterest pin content from a listing
        const response = await agentThink(
          "You are a Pinterest marketing expert. Create an engaging pin for this Etsy listing. Output as JSON: {pinTitle, pinDescription, boardSuggestion, hashtags: [], bestTimeToPost}",
          `Create a Pinterest pin for this Etsy listing:\nTitle: ${task.title}\nDetails: ${task.description}\nTarget ID: ${task.targetId || "unknown"}`
        );
        result = { pinPlan: response };
        break;
      }

      case "pinterest_strategy": {
        // Plan Pinterest marketing strategy
        const response = await agentThink(
          "You are a Pinterest marketing strategist for Etsy sellers. Create a pinning strategy. Output as JSON: {boards: [{name, description, pinFrequency}], contentCalendar: [{day, pinType, topic}], tips: []}",
          `Create a Pinterest strategy for this shop:\nShop focus: ${task.title}\nDetails: ${task.description}`
        );
        result = { strategy: response };
        break;
      }

      default: {
        const response = await agentThink(
          "You are Axle, an autonomous Etsy shop operator. Complete this task and report results.",
          `Task: ${task.title}\nDetails: ${task.description}`
        );
        result = { output: response };
      }
    }

    // Mark completed
    await prisma.agentTask.update({
      where: { id: task.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        resultJson: JSON.stringify(result),
        actualCost: 0.003, // estimate per Claude call
      },
    });

    await logAction({
      type: "agent",
      label: `task_completed: ${task.type}`,
      detail: task.title,
      amountUsd: 0.003,
      ok: true,
    });

    // Create ROI tracker entry if applicable
    if (["seo_optimize", "listing_refresh", "ad_launch", "pinterest_pin", "pinterest_strategy"].includes(task.type)) {
      await prisma.roiTracker.create({
        data: {
          taskId: task.id,
          actionType: task.type,
          targetId: task.targetId,
          targetTitle: task.title,
          costUsd: task.actualCost || 0.003,
        },
      });
    }

    return result;
  } catch (err) {
    await prisma.agentTask.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err.message,
      },
    });

    await logAction({
      type: "agent",
      label: `task_failed: ${task.type}`,
      detail: err.message.slice(0, 500),
      ok: false,
    });

    throw err;
  }
}

/**
 * Agent tick — processes pending tasks
 */
async function agentTick(prisma, logAction) {
  if (agentRunning) return; // prevent overlap
  agentRunning = true;

  try {
    // Find tasks ready to run
    const tasks = await prisma.agentTask.findMany({
      where: {
        status: { in: ["pending", "approved"] },
        OR: [
          { scheduledFor: null },
          { scheduledFor: { lte: new Date() } },
        ],
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: 3, // process up to 3 per tick
    });

    for (const task of tasks) {
      // Check if cost requires approval
      if (task.estimatedCost && task.estimatedCost > APPROVAL_THRESHOLD_USD && task.status !== "approved") {
        await prisma.agentTask.update({
          where: { id: task.id },
          data: { status: "needs_approval" },
        });
        continue;
      }

      try {
        await processTask(prisma, task, logAction);
      } catch (err) {
        console.error(`Agent task ${task.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.error("Agent tick error:", err.message);
  } finally {
    agentRunning = false;
  }
}

/**
 * Start the agent scheduler
 */
export function startAgent(prisma, logAction, intervalMs = 60000) {
  if (agentInterval) return;
  console.log(`[agent] Starting autonomous agent (interval: ${intervalMs / 1000}s)`);
  agentInterval = setInterval(() => agentTick(prisma, logAction), intervalMs);
  // Run first tick after 5 seconds
  setTimeout(() => agentTick(prisma, logAction), 5000);
}

/**
 * Stop the agent scheduler
 */
export function stopAgent() {
  if (agentInterval) {
    clearInterval(agentInterval);
    agentInterval = null;
    console.log("[agent] Agent stopped");
  }
}

/**
 * Get agent status
 */
export async function getAgentStatus(prisma) {
  const pending = await prisma.agentTask.count({ where: { status: "pending" } });
  const running = await prisma.agentTask.count({ where: { status: "running" } });
  const needsApproval = await prisma.agentTask.count({ where: { status: "needs_approval" } });
  const completedToday = await prisma.agentTask.count({
    where: {
      status: "completed",
      completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  });
  const failedToday = await prisma.agentTask.count({
    where: {
      status: "failed",
      completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
  });

  // ROI summary
  const roiEntries = await prisma.roiTracker.findMany({
    where: { roiMultiple: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const totalCost = roiEntries.reduce((s, r) => s + (r.costUsd || 0), 0);
  const totalRevChange = roiEntries.reduce((s, r) => s + (r.revenueChange || 0), 0);
  const avgRoi = roiEntries.length > 0
    ? roiEntries.reduce((s, r) => s + (r.roiMultiple || 0), 0) / roiEntries.length
    : null;

  return {
    active: !!agentInterval,
    pending,
    running,
    needsApproval,
    completedToday,
    failedToday,
    roi: {
      tracked: roiEntries.length,
      totalCost: Math.round(totalCost * 100) / 100,
      totalRevenueChange: Math.round(totalRevChange * 100) / 100,
      averageRoi: avgRoi ? Math.round(avgRoi * 10) / 10 : null,
    },
  };
}

export { agentThink, APPROVAL_THRESHOLD_USD };
