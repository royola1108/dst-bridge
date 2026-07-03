// macro.js — Macro-Action Executor
// Turns high-level goals into sequences of low-level commands.
// dst goal "gather logs 20" → find tree → walk → chop → pickup → count → repeat

import { config } from "./config.js";

const MACRO_PLANS = {
  gather: planGather,
  craft: planCraft,
  build: planBuild,
  "survive-night": planSurviveNight,
  explore: planExplore,
  "return-to-base": planReturnToBase,
};

// Goal registry — maps goal text to a plan
const GOAL_PATTERNS = [
  { re: /^gather\s+(\w+)\s+(\d+)$/, fn: (m) => ({ type: "gather", prefab: m[1], count: parseInt(m[2]) }) },
  { re: /^collect\s+(\w+)\s+(\d+)$/, fn: (m) => ({ type: "gather", prefab: m[1], count: parseInt(m[2]) }) },
  { re: /^craft\s+(\w+)$/, fn: (m) => ({ type: "craft", recipe: m[1] }) },
  { re: /^build\s+(\w+)$/, fn: (m) => ({ type: "build", recipe: m[1] }) },
  { re: /^build\s+(\w+)\s+at\s+(-?\d+)\s+(-?\d+)$/, fn: (m) => ({ type: "build", recipe: m[1], pos: { x: parseFloat(m[2]), z: parseFloat(m[3]) } }) },
  { re: /^survive.?night$/, fn: () => ({ type: "survive-night" }) },
  { re: /^explore\s+(\w+)$/, fn: (m) => ({ type: "explore", direction: m[1] }) },
  { re: /^return.?to.?base$/, fn: () => ({ type: "return-to-base" }) },
];

export class MacroExecutor {
  constructor(stateCache, cmdQueue) {
    this.stateCache = stateCache;
    this.cmdQueue = cmdQueue;
    this.current = null;
    this.history = [];
  }

  // Parse goal text into a structured goal
  parseGoal(text) {
    const lower = text.toLowerCase().trim();
    for (const pat of GOAL_PATTERNS) {
      const m = lower.match(pat.re);
      if (m) return pat.fn(m);
    }
    return null;
  }

  // Start a new goal
  start(goalText, playerUserId) {
    const parsed = this.parseGoal(goalText);
    if (!parsed) {
      return { accepted: false, error: `Unknown goal: "${goalText}"` };
    }

    // Interrupt current goal if any
    if (this.current) {
      this.interrupt();
    }

    const goal = {
      id: "goal-" + Date.now(),
      text: goalText,
      type: parsed.type,
      params: parsed,
      playerUserId,
      status: "running",
      progress: {},
      steps: [],
      stepIndex: 0,
      startedAt: Date.now(),
    };

    const planFn = MACRO_PLANS[parsed.type];
    if (!planFn) {
      return { accepted: false, error: `No plan for goal type: ${parsed.type}` };
    }

    goal.steps = planFn(parsed);
    this.current = goal;
    this.executeNextStep();

    return {
      accepted: true,
      goalId: goal.id,
      message: this.formatGoalStart(goal),
    };
  }

  // Execute the next step in the current goal
  executeNextStep() {
    if (!this.current || this.current.status !== "running") return;

    const step = this.current.steps[this.current.stepIndex];
    if (!step) {
      this.complete("done");
      return;
    }

    // Check interrupt conditions
    if (this.checkInterrupt()) {
      this.pause();
      return;
    }

    // Dynamic step: generate command based on current state
    if (step.dynamic) {
      const cmd = step.dynamic(this.getState(), this.current);
      if (!cmd) {
        // Can't execute this step right now, try again next tick
        return;
      }
      this.enqueueCommand(cmd, step);
      return;
    }

    // Static step: direct command
    if (step.command) {
      this.enqueueCommand(step.command, step);
      return;
    }

    // No command for this step, skip to next
    this.current.stepIndex++;
    this.executeNextStep();
  }

  // Enqueue a command and wait for completion
  enqueueCommand(cmd, step) {
    cmd.stateSeq = this.stateCache.get(this.current.playerUserId)?.seq || 0;
    const queued = this.cmdQueue.enqueue(cmd, this.current.playerUserId);
    queued.onComplete = (result) => this.onStepComplete(step, result);
    this.current.currentCmdId = queued.id;
  }

  // Called when a command completes
  onStepComplete(step, result) {
    if (!this.current) return;

    if (result.status === "completed") {
      // Update progress
      if (step.updateProgress) {
        step.updateProgress(this.current.progress, result, this.getState());
      }
      this.current.stepIndex++;
      this.current.currentCmdId = null;
      this.executeNextStep();
    } else if (result.status === "failed" || result.status === "timeout") {
      // Check if step has a retry/fallback
      if (step.onFail) {
        const retryCmd = step.onFail(result, this.getState(), this.current);
        if (retryCmd) {
          this.enqueueCommand(retryCmd, step);
          return;
        }
      }
      this.complete("failed", result.reason || "step failed");
    }
  }

  // Check if the current goal should be interrupted
  checkInterrupt() {
    const state = this.getState();
    if (!state || !state.player) return false;

    // Interrupt on death
    if (state.player.isGhost) {
      this.complete("interrupted", "player died");
      return true;
    }

    // Interrupt on critical HP
    if (state.player.health < 25 && state.player.maxHealth > 0) {
      this.complete("interrupted", "health critical");
      return true;
    }

    // Interrupt on night (unless goal is survive-night)
    if (this.current.type !== "survive-night") {
      const phase = state.world?.phase;
      if (phase === "night" && !state.player.inLight) {
        this.complete("interrupted", "night fell and no light");
        return true;
      }
    }

    return false;
  }

  pause() {
    if (this.current) this.current.status = "paused";
  }

  resume() {
    if (this.current && this.current.status === "paused") {
      this.current.status = "running";
      this.executeNextStep();
    }
  }

  interrupt() {
    if (this.current) {
      this.current.status = "interrupted";
      this.cmdQueue.cancelAll(this.current.playerUserId);
      this.history.push(this.current);
      this.current = null;
    }
  }

  complete(status, reason) {
    if (!this.current) return;
    this.current.status = status;
    this.current.reason = reason;
    this.current.completedAt = Date.now();
    this.history.push(this.current);
    this.current = null;
  }

  getState() {
    const puid = this.current?.playerUserId;
    if (!puid) return null;
    const slot = this.stateCache.get(puid);
    return slot?.current || null;
  }

  // Get current goal status for dst situation / dst goals
  getStatus() {
    return this.current;
  }

  getHistory() {
    return this.history;
  }

  // Check if a critical event should interrupt the goal
  handleCriticalEvent(event) {
    if (!this.current) return false;
    if (event.critical) {
      if (event.kind === "chat") {
        // Chat always interrupts — surface to CC
        this.complete("interrupted", `player said: "${event.data?.message || ""}"`);
        return true;
      }
      if (event.kind === "death") {
        this.complete("interrupted", "player died");
        return true;
      }
    }
    return false;
  }

  formatGoalStart(goal) {
    const p = goal.params;
    switch (p.type) {
      case "gather":
        const have = this.countItem(p.prefab);
        return `goal accepted: gather ${p.prefab} ${p.count}\n  current ${p.prefab}: ${have}, need ${p.count - have} more\n  plan: find → walk → ${p.prefab === "logs" ? "chop" : "act"} → pickup → count`;
      case "craft":
      case "build":
        return `goal accepted: ${p.type} ${p.recipe}\n  plan: check materials → gather if needed → ${p.type}`;
      case "survive-night":
        return `goal accepted: survive-night\n  plan: build campfire → stay near fire → wait for dawn`;
      default:
        return `goal accepted: ${goal.text}`;
    }
  }

  // Count items in inventory by prefab
  countItem(prefab) {
    const state = this.getState();
    if (!state?.inventory) return 0;
    let total = 0;
    for (const item of state.inventory) {
      // Handle aliases
      const aliases = ITEM_ALIASES[prefab] || [prefab];
      if (aliases.includes(item.prefab)) {
        total += item.stackSize || 1;
      }
    }
    return total;
  }
}

// Item name aliases (user says "logs", game has "log")
const ITEM_ALIASES = {
  logs: ["log"],
  grass: ["cutgrass"],
  twigs: ["twigs", "twig"],
  flint: ["flint"],
  stone: ["rocks", "stone"],
  rocks: ["rocks", "stone"],
  gold: ["goldnugget"],
  wood: ["log"],
  boards: ["boards"],
  rope: ["rope"],
};

// ─── Plan generators ───

function planGather(params) {
  const { prefab, count } = params;
  const aliases = ITEM_ALIASES[prefab] || [prefab];

  return [
    {
      id: "check-inventory",
      description: `Check if we already have ${count} ${prefab}`,
      dynamic: (state, goal) => {
        if (!state) return null;
        let have = 0;
        for (const item of state.inventory || []) {
          if (aliases.includes(item.prefab)) have += item.stackSize || 1;
        }
        goal.progress.have = have;
        goal.progress.need = count;
        if (have >= count) return { action: "__noop__" }; // done
        return null; // proceed to next step
      },
      command: null, // no command, just check
    },
    {
      id: "gather-loop",
      description: `Find and gather ${prefab} until ${count}`,
      dynamic: (state, goal) => {
        if (!state) return null;
        let have = 0;
        for (const item of state.inventory || []) {
          if (aliases.includes(item.prefab)) have += item.stackSize || 1;
        }
        goal.progress.have = have;
        if (have >= count) return null; // done, move to next step (there is none)

        // Find nearest target based on prefab
        const target = findGatherTarget(state, prefab, aliases);
        if (!target) {
          // No target nearby, explore
          return { action: "walk_to", pos: explorePos(state, goal) };
        }

        // Determine action
        const action = gatherAction(prefab, target);
        return {
          action: action,
          targetGuid: target.guid,
        };
      },
      onFail: (result, state, goal) => {
        // Target disappeared, try again next tick
        return null; // will retry on next executeNextStep
      },
      updateProgress: (progress, result, state) => {
        let have = 0;
        for (const item of state.inventory || []) {
          if (aliases.includes(item.prefab)) have += item.stackSize || 1;
        }
        progress.have = have;
        progress.need = count;
      },
    },
  ];
}

function planCraft(params) {
  const { recipe } = params;
  return [
    {
      id: "craft",
      description: `Craft ${recipe}`,
      dynamic: (state, goal) => {
        if (!state) return null;
        // Check if we can build
        const canBuild = state.recipes?.some((r) => r.recipe === recipe && r.canBuild);
        if (!canBuild) {
          // Can't build — need materials, fail for now
          goal._failReason = `missing materials for ${recipe}`;
          return null;
        }
        return { action: "build", recipe: recipe };
      },
    },
  ];
}

function planBuild(params) {
  const { recipe, pos } = params;
  return [
    {
      id: "build",
      description: `Build ${recipe}${pos ? ` at (${pos.x},${pos.z})` : ""}`,
      dynamic: (state, goal) => {
        if (!state) return null;
        const canBuild = state.recipes?.some((r) => r.recipe === recipe && r.canBuild);
        if (!canBuild) {
          goal._failReason = `missing materials for ${recipe}`;
          return null;
        }
        return { action: "build", recipe: recipe, pos: pos || null };
      },
    },
  ];
}

function planSurviveNight(params) {
  return [
    {
      id: "build-fire",
      description: "Build campfire",
      dynamic: (state, goal) => {
        if (!state) return null;
        // Check if already near a fire
        const fire = state.nearby?.find((e) =>
          ["campfire", "firepit"].includes(e.prefab)
        );
        if (fire && fire.distance < 5) {
          // Already near fire, skip
          return null;
        }
        // Check if can build campfire
        const canBuild = state.recipes?.some((r) => r.recipe === "campfire" && r.canBuild);
        if (!canBuild) {
          goal._failReason = "no materials for campfire";
          return null;
        }
        return { action: "build", recipe: "campfire" };
      },
    },
    {
      id: "wait-dawn",
      description: "Wait for dawn",
      dynamic: (state, goal) => {
        if (!state) return null;
        const phase = state.world?.phase;
        if (phase === "day") {
          return null; // dawn arrived, done
        }
        // Stay near fire — if not near fire, walk to it
        const fire = state.nearby?.find((e) =>
          ["campfire", "firepit"].includes(e.prefab)
        );
        if (fire && fire.distance > 3) {
          return { action: "walk_to_entity", targetGuid: fire.guid };
        }
        // Just wait
        return { action: "__wait__" };
      },
    },
  ];
}

function planExplore(params) {
  const { direction } = params;
  return [
    {
      id: "explore",
      description: `Explore ${direction}`,
      dynamic: (state, goal) => {
        if (!state) return null;
        return { action: "walk_to", pos: exploreDir(state, direction) };
      },
    },
  ];
}

function planReturnToBase(params) {
  return [
    {
      id: "return",
      description: "Return to base (nearest campfire/firepit)",
      dynamic: (state, goal) => {
        if (!state) return null;
        const fire = state.nearby?.find((e) =>
          ["campfire", "firepit", "sciencemachine"].includes(e.prefab)
        );
        if (!fire) {
          goal._failReason = "no known base location";
          return null;
        }
        if (fire.distance < 3) return null; // arrived
        return { action: "walk_to_entity", targetGuid: fire.guid };
      },
    },
  ];
}

// ─── Helpers ───

function findGatherTarget(state, prefab, aliases) {
  if (!state?.nearby) return null;

  // Map prefab to action + entity filter
  const gatherMap = {
    logs: { action: "chop", entityPrefabs: ["evergreen", "deciduoustree", "mushtree"] },
    log: { action: "chop", entityPrefabs: ["evergreen", "deciduoustree", "mushtree"] },
    wood: { action: "chop", entityPrefabs: ["evergreen", "deciduoustree"] },
    grass: { action: "pick", entityPrefabs: ["grass"] },
    cutgrass: { action: "pick", entityPrefabs: ["grass"] },
    twigs: { action: "pick", entityPrefabs: ["sapling"] },
    twig: { action: "pick", entityPrefabs: ["sapling"] },
    flint: { action: "pickup", entityPrefabs: ["flint"] },
    stone: { action: "mine", entityPrefabs: ["rock1", "rock2", "rocks"] },
    rocks: { action: "mine", entityPrefabs: ["rock1", "rock2", "rocks"] },
    gold: { action: "mine", entityPrefabs: ["goldnugget", "rock2"] },
  };

  const g = gatherMap[prefab] || gatherMap[aliases[0]];
  if (!g) return null;

  // Also check ground items first (pickup)
  for (const ent of state.nearby) {
    if (aliases.includes(ent.prefab) && ent.actions?.includes("pickup")) {
      return ent;
    }
  }

  // Find nearest gatherable entity
  for (const ent of state.nearby) {
    if (g.entityPrefabs.includes(ent.prefab) && ent.actions?.includes(g.action)) {
      return ent;
    }
  }

  return null;
}

function gatherAction(prefab, target) {
  if (target.actions?.includes("pickup") && isItemPrefab(prefab, target.prefab)) {
    return "pickup";
  }
  const gatherMap = {
    logs: "chop", log: "chop", wood: "chop",
    grass: "pick", cutgrass: "pick",
    twigs: "pick", twig: "pick",
    flint: "pickup",
    stone: "mine", rocks: "mine",
    gold: "mine",
  };
  return gatherMap[prefab] || "pickup";
}

function isItemPrefab(prefab, entityPrefab) {
  const aliases = ITEM_ALIASES[prefab] || [prefab];
  return aliases.includes(entityPrefab);
}

function explorePos(state, goal) {
  const px = state?.player?.pos?.x || 0;
  const pz = state?.player?.pos?.z || 0;
  // Walk 30 units in a random direction
  const angle = Math.random() * Math.PI * 2;
  return {
    x: Math.round(px + Math.cos(angle) * 30),
    z: Math.round(pz + Math.sin(angle) * 30),
  };
}

function exploreDir(state, direction) {
  const px = state?.player?.pos?.x || 0;
  const pz = state?.player?.pos?.z || 0;
  const dist = 40;
  const dirs = {
    north: { x: 0, z: -dist },
    south: { x: 0, z: dist },
    east: { x: dist, z: 0 },
    west: { x: -dist, z: 0 },
  };
  const d = dirs[direction] || dirs.north;
  return { x: Math.round(px + d.x), z: Math.round(pz + d.z) };
}
