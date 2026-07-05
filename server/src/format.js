const BEARING_SHORT = {
  front: "F",
  "front-left": "FL",
  "front-right": "FR",
  left: "L",
  right: "R",
  behind: "B",
  "behind-left": "BL",
  "behind-right": "BR",
};

// Append unread chat messages to any CLI output
export function appendUnreadChats(text, stateCache, puid) {
  if (!stateCache || !puid) return text;
  const unread = stateCache.getUnreadChats(puid);
  if (!unread || unread.length === 0) return text;
  const lines = unread.map((e) => `  <${e.data.from || "player"}> ${e.data.message}`);
  return text + "\n\nunread chat:\n" + lines.join("\n");
}

export function formatState(slot) {
  if (!slot || !slot.current) return "DST: NOT CONNECTED";
  const s = slot.current;
  const p = s.player;
  const w = s.world;
  const lines = [
    `HP:${p.health}/${p.maxHealth} Hgr:${p.hunger}/${p.maxHunger} San:${p.sanity}/${p.maxSanity} Temp:${p.temperature}C Wet:${p.moisture}`,
    `Day${w.cycle} ${w.season} ${w.phase}(${w.remainingDaysInSeason}/12) Moon:${w.moonPhase} Rain:${w.isRaining ? "yes" : "no"}${w.isSnowing ? " Snow:yes" : ""}`,
    `Pos:(${Math.round(p.pos.x)},${Math.round(p.pos.z)}) Light:${p.inLight ? "yes" : "no"} Busy:${p.isBusy ? "yes" : "no"} Ghost:${p.isGhost ? "yes" : "no"}`,
    `Equip:${s.equipped?.hands?.prefab || "-"} Head:${s.equipped?.head?.prefab || "-"} Body:${s.equipped?.body?.prefab || "-"}`,
    formatInvLine(s.inventory),
    formatRecipes(s.recipes),
  ];
  return lines.join("\n");
}

export function formatNearby(slot, filter) {
  if (!slot || !slot.current) return "DST: NOT CONNECTED";
  let entities = slot.current.nearby || [];
  if (filter?.filterPrefab) {
    entities = entities.filter((e) => e.prefab === filter.filterPrefab);
  }
  if (filter?.filterAction) {
    entities = entities.filter((e) => e.actions && e.actions.includes(filter.filterAction));
  }
  const max = filter?.maxCount || 20;
  entities = entities.slice(0, max);
  const label = filter?.filterPrefab || filter?.filterAction || "all";
  if (entities.length === 0) return `Nearby[${label}] 0 found`;
  const lines = entities.map((e) => {
    const b = BEARING_SHORT[e.bearing] || "?";
    const st = formatEntityState(e);
    return `  #${e.guid} ${(e.prefab || "?").padEnd(10)} ${e.distance.toFixed(1)}m ${b.padEnd(3)} [${(e.actions || []).join(",")}]${st ? " " + st : ""}`;
  });
  return `Nearby[${label}] ${entities.length} found:\n` + lines.join("\n");
}

function formatInvLine(inv) {
  if (!inv || inv.length === 0) return "Inv: (empty)";
  const items = inv.map((i) => {
    const uses = i.uses != null ? `(${i.uses}u)` : "";
    const stack = i.stackSize > 1 ? `x${i.stackSize}` : "";
    return `${i.prefab}${stack}${uses}`;
  });
  return `Inv[${inv.length}]: ${items.join(" ")}`;
}

export function formatRecipes(recipes) {
  if (!recipes || recipes.length === 0) return "Recipes: (none)";
  const can = recipes.filter((r) => r.canBuild);
  const need = recipes.filter((r) => !r.canBuild);
  const lines = [];
  if (can.length) lines.push(`Recipes[can]: ${can.map((r) => r.recipe).join(" ")}`);
  if (need.length) {
    const needStr = need
      .map((r) => {
        const missing = r.ingredients
          .filter((i) => i.have < i.need)
          .map((i) => `+${i.need - i.have}${i.item}`)
          .join(" ");
        return `${r.recipe}(${missing})`;
      })
      .join(" ");
    lines.push(`Recipes[need]: ${needStr}`);
  }
  return lines.join("\n");
}

export function formatInventory(slot) {
  if (!slot || !slot.current) return "DST: NOT CONNECTED";
  const inv = slot.current.inventory || [];
  const eq = slot.current.equipped || {};
  if (inv.length === 0) return "Inv: (empty)";
  const items = inv.map((i) => {
    const uses = i.uses != null ? `(${i.uses}u)` : "";
    const stack = i.stackSize > 1 ? `x${i.stackSize}` : "";
    const fresh = i.freshness != null && i.freshness < 1 ? ` fresh:${i.freshness.toFixed(1)}` : "";
    const eq2 = i.equipSlot ? ` equip:${i.equipSlot}` : "";
    return `  [${i.slot}] ${(i.prefab || "?").padEnd(10)} ${stack}${uses}${fresh}${eq2}`;
  });
  const eqLines = [
    `  hands: ${eq.hands ? eq.hands.prefab + (eq.hands.uses != null ? `(${eq.hands.uses}u)` : "") : "-"}`,
    `  head:  ${eq.head ? eq.head.prefab : "-"}`,
    `  body:  ${eq.body ? eq.body.prefab : "-"}`,
  ];
  return `Inv[${inv.length}]:\n` + items.join("\n") + "\nEquipped:\n" + eqLines.join("\n");
}

export function formatEvents(slot, since, limit) {
  if (!slot) return "DST: NOT CONNECTED";
  let events = slot.events || [];
  if (since != null) events = events.filter((e) => e.seq > since);
  events = events.slice(-limit);
  if (events.length === 0) return "Events: (none)";
  const now = Date.now();
  const lines = events.map((e) => {
    const ago = Math.round((now - (e.ts || 0)) / 1000);
    const critical = e.critical ? " ⚠" : "";
    if (e.kind === "chat" && e.data?.message) {
      return `  #${e.seq} [chat] "${e.data.message}"${critical}  ${ago}s ago`;
    }
    const data = e.data ? " " + JSON.stringify(e.data) : "";
    return `  #${e.seq} [${e.kind}]${data}${critical}  ${ago}s ago`;
  });
  return `Events[${events.length}]:\n` + lines.join("\n");
}

export function formatQueue(queue, playerUserId) {
  const items = queue.getQueueInfo(playerUserId);
  if (items.length === 0) return "Queue: (empty)";
  const lines = items.map(
    (c) => `  ${c.id} [${c.action}] ${c.status}${c.targetGuid ? " #" + c.targetGuid : ""}`
  );
  return `Queue[${items.length}]:\n` + lines.join("\n");
}

export function formatStatus(stateCache, queue, playerUserId, uptime, totalProcessed, port) {
  const connected = stateCache.isConnected(playerUserId);
  const ago = connected
    ? Math.round((Date.now() - stateCache.get(playerUserId).lastUpdate) / 1000) + "s ago"
    : "NOT CONNECTED";
  const qItems = queue.getQueueInfo(playerUserId);
  const pending = qItems.filter((c) => c.status === "queued").length;
  const executing = qItems.filter((c) => c.status === "leased" || c.status === "executing").length;
  return [
    `Bridge: localhost:${port}`,
    `DST:    ${connected ? "connected (last state " + ago + ")" : ago}`,
    `Queue:  ${pending} pending, ${executing} executing`,
    `Uptime: ${Math.round(uptime / 1000)}s  cmds processed: ${totalProcessed}`,
  ].join("\n");
}

export function formatDoResult(cmd) {
  const target = cmd.targetGuid ? `#${cmd.targetGuid}` : "";
  const pos = cmd.pos ? `(${cmd.pos.x},${cmd.pos.z})` : "";
  const recipe = cmd.recipe || "";
  const detail = target || pos || recipe;
  return `✓ queued: ${cmd.action}${detail ? " " + detail : ""}\n  id=${cmd.id} wait~2s for DST to pick up`;
}

export function formatCancelResult(cancelled) {
  if (cancelled.length === 0) return "✓ queue was empty, nothing to cancel";
  return `✓ cancelled ${cancelled.length} queued commands\n  current action: aborted`;
}

function formatEntityState(e) {
  if (!e.state) return "";
  const s = e.state;
  const parts = [];
  if (s.growthStage) parts.push(s.growthStage);
  if (s.isBurning) parts.push("burning");
  if (s.isStump) parts.push("stump");
  if (s.picked) parts.push("picked");
  if (s.isWilted) parts.push("wilted");
  if (s.fuelLevel != null && s.fuelMax != null) parts.push(`fuel:${s.fuelLevel}/${s.fuelMax}`);
  if (s.health != null) parts.push(`hp:${s.health}`);
  if (s.isSleeping) parts.push("sleeping");
  if (s.isFleeing) parts.push("fleeing");
  if (s.isAttacking) parts.push("attacking");
  if (s.freshness != null && s.freshness < 1) parts.push(`fresh:${s.freshness.toFixed(1)}`);
  if (s.stackSize != null && s.stackSize > 1) parts.push(`x${s.stackSize}`);
  return parts.join(" ");
}

// ─── Phase 2 formatters ───

export function formatSituation(slot, goal, events, alerts) {
  if (!slot || !slot.current) return "DST: NOT CONNECTED";
  const s = slot.current;
  const p = s.player;
  const w = s.world;
  const lines = [
    "=== SITUATION ===",
    `HP:${p.health}/${p.maxHealth} Hgr:${p.hunger}/${p.maxHunger} San:${p.sanity}/${p.maxSanity}`,
    `Day${w.cycle} ${w.season} ${w.phase}(${w.remainingDaysInSeason}/12) Moon:${w.moonPhase} Rain:${w.isRaining ? "yes" : "no"}`,
    `Pos:(${Math.round(p.pos.x)},${Math.round(p.pos.z)}) Light:${p.inLight ? "yes" : "no"} Busy:${p.isBusy ? "yes" : "no"} Ghost:${p.isGhost ? "yes" : "no"}`,
  ];

  if (goal) {
    lines.push("", `Goal: ${goal.text}`, `  Progress: ${formatProgress(goal)}`, `  Status: ${goal.status}`);
  }

  if (alerts && alerts.length) {
    lines.push("", "Alerts:");
    alerts.forEach((a) => lines.push(`  ${a}`));
  }

  if (events && events.length) {
    lines.push("", `Events (last 60s):`);
    events.forEach((e) => {
      if (e.kind === "chat") {
        lines.push(`  [chat] "${e.data?.message || ""}"`);
      } else {
        lines.push(`  [${e.kind}] ${e.data ? JSON.stringify(e.data) : ""}`);
      }
    });
  }

  return lines.join("\n");
}

export function formatWaitResult(result) {
  if (result.status === "no_goal") return result.message || "no active goal";
  if (result.status === "timeout") return result.message || "timeout — no events";
  if (result.status === "event" && result.event) {
    const ev = result.event;
    const lines = [
      "=== WAIT RESULT ===",
      `status: event (${ev.kind})`,
    ];
    if (ev.data) {
      if (ev.kind === "chat") {
        const from = ev.data.from || "player";
        lines.push(`chat: <${from}> ${ev.data.message || ""}`);
      } else {
        lines.push(`data: ${JSON.stringify(ev.data)}`);
      }
    }
    return lines.join("\n");
  }
  const lines = [
    "=== WAIT RESULT ===",
    `goal: ${result.goal}`,
    `status: ${result.status}`,
  ];
  if (result.reason) lines.push(`reason: ${result.reason}`);
  if (result.elapsed) lines.push(`elapsed: ${result.elapsed}`);
  if (result.progress && Object.keys(result.progress).length) {
    lines.push(`progress: ${JSON.stringify(result.progress)}`);
  }
  if (result.event) {
    const ev = result.event;
    if (ev.kind === "chat") {
      lines.push("", `chat: <${ev.data?.from || "player"}> ${ev.data?.message || ""}`);
    } else {
      lines.push("", `event: ${ev.kind} ${JSON.stringify(ev.data || {})}`);
    }
  }
  if (result.situation) lines.push("", `current: ${result.situation}`);
  if (result.suggested) lines.push("", `suggested next: ${result.suggested}`);
  return lines.join("\n");
}

export function formatInterruptResult(cancelled, macro) {
  const goal = macro.getHistory();
  const last = goal[goal.length - 1];
  const goalText = last ? last.text : "(no goal)";
  const lines = [
    `✓ interrupted: ${goalText}`,
    `  ${cancelled.length} queued commands cancelled`,
    `  current action: aborted`,
  ];
  return lines.join("\n");
}

function formatProgress(goal) {
  const p = goal.progress || {};
  if (p.have != null && p.need != null) {
    return `${p.have}/${p.need}`;
  }
  return "";
}

