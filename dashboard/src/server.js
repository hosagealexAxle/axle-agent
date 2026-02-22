app.post("/api/kill-switch", async (req, res) => {
  const enabled = Boolean(req.body?.enabled);

  await prisma.systemState.upsert({
    where: { id: "global" },
    update: { killSwitch: enabled },
    create: { id: "global", killSwitch: enabled },
  });

  res.json({ ok: true, killSwitch: enabled });
});

app.get("/api/kill-switch", async (_req, res) => {
  const state = await prisma.systemState.findUnique({
    where: { id: "global" },
  });
  res.json({ ok: true, killSwitch: state?.killSwitch ?? false });
});
