// waitManager.js — Long-poll wait for goal completion / critical events
// dst wait blocks until goal terminal state or timeout

import { config } from "./config.js";

export class WaitManager {
  constructor(macroExecutor, stateCache) {
    this.macro = macroExecutor;
    this.stateCache = stateCache;
    this.pendingWaits = []; // active wait requests
  }

  // Start a wait — returns a promise that resolves when goal ends, critical event, or timeout
  async wait(playerUserId, timeout = config.waitDefaultTimeout) {
    return new Promise((resolve) => {
      const waitEntry = {
        playerUserId,
        timeoutId: null,
        resolve,
        startedAt: Date.now(),
      };

      // Set timeout
      waitEntry.timeoutId = setTimeout(() => {
        this.removeWait(waitEntry);
        resolve(this.buildTimeoutResult());
      }, timeout * 1000);

      // Always wait — even without an active goal, critical events (chat) can arrive
      this.pendingWaits.push(waitEntry);
    });
  }

  // Called when goal status changes — resolve all pending waits
  notifyGoalChange() {
    const goal = this.macro.getStatus();
    if (!goal) return;

    // Goal still running, no need to notify
    if (goal.status === "running" || goal.status === "paused") return;

    // Goal ended — resolve all waits
    const result = this.buildGoalResult(goal);
    for (const wait of this.pendingWaits) {
      clearTimeout(wait.timeoutId);
      wait.resolve(result);
    }
    this.pendingWaits = [];
  }

  // Called when a critical event arrives — resolve all waits
  notifyCriticalEvent(event) {
    if (this.pendingWaits.length === 0) return;

    const goal = this.macro.getStatus();
    if (goal) {
      // Goal is still active — don't resolve, let macro handle interruption
      return;
    }

    // No active goal — resolve waits with the event
    const history = this.macro.getHistory();
    const last = history[history.length - 1];
    if (last) {
      const result = this.buildGoalResult(last);
      result.event = event;
      for (const wait of this.pendingWaits) {
        clearTimeout(wait.timeoutId);
        wait.resolve(result);
      }
    } else {
      // No goal history either — just return the event
      for (const wait of this.pendingWaits) {
        clearTimeout(wait.timeoutId);
        wait.resolve({ status: "event", event });
      }
    }
    this.pendingWaits = [];
  }

  removeWait(waitEntry) {
    const idx = this.pendingWaits.indexOf(waitEntry);
    if (idx >= 0) this.pendingWaits.splice(idx, 1);
  }

  buildGoalResult(goal) {
    const elapsed = Math.round((Date.now() - goal.startedAt) / 1000);
    const result = {
      goal: goal.text,
      status: goal.status,
      reason: goal.reason || null,
      elapsed: `${elapsed}s`,
      progress: goal.progress || {},
    };

    // Add current situation snapshot
    const state = this.stateCache.get(goal.playerUserId)?.current;
    if (state) {
      result.situation = formatSituationCompact(state);
    }

    // Suggested next action
    result.suggested = this.suggestNext(goal, state);

    return result;
  }

  buildTimeoutResult() {
    const goal = this.macro.getStatus();
    if (!goal) return { status: "timeout", message: "no events or goal changes — try again" };

    const elapsed = Math.round((Date.now() - goal.startedAt) / 1000);
    return {
      goal: goal.text,
      status: "still_running",
      elapsed: `${elapsed}s (timeout)`,
      progress: goal.progress || {},
      message: "use 'dst wait' to continue waiting",
    };
  }

  suggestNext(goal, state) {
    if (goal.status === "done") {
      return "dst situation or dst goal for next task";
    }
    if (goal.status === "failed") {
      return "dst situation to assess, then dst goal to retry or change plan";
    }
    if (goal.status === "interrupted") {
      if (goal.reason?.includes("night")) return "dst goal survive-night";
      if (goal.reason?.includes("health")) return "dst goal gather food or dst situation";
      if (goal.reason?.includes("chat")) return "respond to player message";
      return "dst situation to reassess";
    }
    return "dst situation";
  }
}

function formatSituationCompact(state) {
  if (!state) return "";
  const p = state.player;
  const w = state.world;
  return `HP:${p.health}/${p.maxHealth} Hgr:${p.hunger}/${p.maxHunger} | Day${w.cycle} ${w.season} ${w.phase} | Pos:(${Math.round(p.pos.x)},${Math.round(p.pos.z)})`;
}
