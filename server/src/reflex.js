// reflex.js — Reflex Engine
// Emergency events → deterministic rules → Hermes/DeepSeek → escalate to CC
// Three priority layers:
//   1. Deterministic rules (0ms) — simple: has torch → equip torch
//   2. Hermes via CLI (~1-2s) — complex: attacked, need to decide fight/flight
//   3. Notify CC (async) — can't handle → surface via dst wait

import { config } from "./config.js";
import { callReflexLLM } from "./deepseek.js";

const REFLEX_EVENTS = new Set([
  "attacked",
  "night",
  "health_critical",
  "hunger_critical",
  "freeze_warning",
  "overheat_warning",
]);

const NOTIFY_EVENTS = new Set([
  "dusk",
  "sanity_low",
  "boss_nearby",
  "season_changed",
]);

export class ReflexEngine {
  constructor(stateCache, cmdQueue, macroExecutor) {
    this.stateCache = stateCache;
    this.cmdQueue = cmdQueue;
    this.macro = macroExecutor;
    this.reflexLog = [];
    this.maxLog = 50;
    this.enabled = config.deepseekKey !== "" || true; // always enable, LLM is optional
  }

  async handleEvent(event, playerUserId) {
    if (!this.enabled) return;

    const kind = event.kind;

    // Layer 1: deterministic rules
    const ruleResult = this.matchRules(kind, playerUserId);
    if (ruleResult) {
      this.log(kind, "rule", ruleResult);
      for (const cmd of ruleResult) {
        cmd.stateSeq = this.stateCache.get(playerUserId)?.seq || 0;
        this.cmdQueue.enqueue(cmd, playerUserId);
      }
      return;
    }

    // Layer 2: Hermes / DeepSeek for reflex events
    if (REFLEX_EVENTS.has(kind)) {
      // Pause macro while handling reflex
      this.macro.pause();

      try {
        const action = await callReflexLLM(this.buildPrompt(kind, event, playerUserId));
        if (action && action.action) {
          action.stateSeq = this.stateCache.get(playerUserId)?.seq || 0;
          this.cmdQueue.enqueue(action, playerUserId);
          this.log(kind, "llm", action);
        } else if (action && action.escalate) {
          // LLM says we can't handle this — escalate to CC
          this.macro.complete("interrupted", `reflex: ${action.reason || kind}`);
          this.log(kind, "escalate", action);
        } else {
          this.log(kind, "llm_no_action", null);
        }
      } catch (e) {
        // LLM failed — try fallback rules
        const fallback = this.fallbackRules(kind, playerUserId);
        if (fallback) {
          for (const cmd of fallback) {
            cmd.stateSeq = this.stateCache.get(playerUserId)?.seq || 0;
            this.cmdQueue.enqueue(cmd, playerUserId);
          }
          this.log(kind, "fallback", fallback);
        } else {
          this.log(kind, "llm_failed", e.message);
        }
      }

      // Resume macro
      this.macro.resume();
      return;
    }

    // Layer 3: just log, CC will see it in dst events / dst situation
    if (NOTIFY_EVENTS.has(kind)) {
      this.log(kind, "notified", null);
      return;
    }
  }

  // Layer 1: deterministic rules — instant, no LLM needed
  matchRules(kind, playerUserId) {
    const state = this.stateCache.get(playerUserId)?.current;
    if (!state) return null;

    switch (kind) {
      case "night": {
        // Have torch in inventory → equip it
        const torch = state.inventory?.find(
          (i) => i.prefab === "torch" || i.prefab === "torchfire"
        );
        if (torch) {
          return [{ action: "equip", invObjectGuid: torch.guid }];
        }
        // Near a campfire → walk to it
        const fire = state.nearby?.find(
          (e) => e.prefab === "campfire" || e.prefab === "firepit"
        );
        if (fire && fire.distance < 10) {
          return [{ action: "walk_to_entity", targetGuid: fire.guid }];
        }
        // Can build campfire → build one
        const canFire = state.recipes?.some(
          (r) => r.recipe === "campfire" && r.canBuild
        );
        if (canFire) {
          return [{ action: "build", recipe: "campfire" }];
        }
        return null; // need LLM
      }

      case "hunger_critical": {
        // Have food in inventory → eat it
        const food = state.inventory?.find((i) =>
          i.actions?.includes("eat") || ["berries", "carrot", "meat", "smallmeat", "cookedmeat", "fruit", "seeds"].includes(i.prefab)
        );
        if (food) {
          return [{ action: "eat", targetGuid: food.guid }];
        }
        return null; // need LLM to find food
      }

      case "freeze_warning": {
        // Near fire → walk to it
        const fire = state.nearby?.find(
          (e) => e.prefab === "campfire" || e.prefab === "firepit"
        );
        if (fire) {
          return [{ action: "walk_to_entity", targetGuid: fire.guid }];
        }
        // Have torch → equip (gives a little warmth)
        const torch = state.inventory?.find((i) => i.prefab === "torch");
        if (torch) {
          return [{ action: "equip", invObjectGuid: torch.guid }];
        }
        return null;
      }

      case "overheat_warning": {
        // Have a thermal stone or umbrella → equip
        const cool = state.inventory?.find(
          (i) => i.prefab === "umbrella" || i.prefab === "eyebrellahat"
        );
        if (cool) {
          return [{ action: "equip", invObjectGuid: cool.guid }];
        }
        return null;
      }

      case "health_critical":
      case "attacked":
        // These need LLM — too situational for simple rules
        return null;

      default:
        return null;
    }
  }

  // Fallback rules when LLM is unavailable
  fallbackRules(kind, playerUserId) {
    const state = this.stateCache.get(playerUserId)?.current;
    if (!state) return null;

    switch (kind) {
      case "attacked": {
        // Simple: if HP < 50, run away (walk in opposite direction)
        if (state.player.health < 50) {
          const px = state.player.pos.x;
          const pz = state.player.pos.z;
          return [
            { action: "walk_to", pos: { x: px + 20, z: pz + 20 } },
          ];
        }
        return null;
      }
      case "night":
        return this.matchRules("night", playerUserId);
      default:
        return null;
    }
  }

  // Build prompt for Hermes/DeepSeek
  buildPrompt(kind, event, playerUserId) {
    const state = this.stateCache.get(playerUserId)?.current;
    if (!state) return null;

    const p = state.player;
    const w = state.world;
    const nearby = (state.nearby || []).slice(0, 8);
    const inv = state.inventory || [];

    const nearbyStr = nearby
      .map((e) => `  #${e.guid} ${e.prefab} ${e.distance}m [${e.actions?.join(",")}]`)
      .join("\n");

    const invStr = inv
      .map((i) => `  ${i.prefab} x${i.stackSize || 1}${i.uses ? ` (${i.uses}u)` : ""}`)
      .join("\n");

    const eventData = event.data ? JSON.stringify(event.data) : "";

    return {
      system: `You are a Don't Starve Together survival AI. Make ONE action decision in 1 second.
Output ONLY a JSON object, no explanation.
Format: {"action":"walk_to","pos":{"x":0,"z":0}}
Or: {"action":"chop","targetGuid":12345}
Or: {"action":"equip","invObjectGuid":12345}
Or: {"action":"build","recipe":"campfire"}
Or: {"action":"attack","targetGuid":12345}
Or: {"action":"eat","targetGuid":12345}
If the situation is too dangerous to handle alone, output: {"escalate":true,"reason":"brief reason"}`,
      user: `EMERGENCY: ${kind}${eventData ? " " + eventData : ""}
State: HP:${p.health}/${p.maxHealth} Hgr:${p.hunger}/${p.maxHunger} San:${p.sanity}/${p.maxSanity}
Day${w.cycle} ${w.season} ${w.phase} Light:${p.inLight ? "yes" : "no"} Ghost:${p.isGhost ? "yes" : "no"}
Pos:(${Math.round(p.pos.x)},${Math.round(p.pos.z)}) Equip:${state.equipped?.hands?.prefab || "none"}
Nearby:
${nearbyStr || "  (nothing)"}
Inventory:
${invStr || "  (empty)"}
Make ONE decision:`,
    };
  }

  log(kind, source, data) {
    this.reflexLog.push({
      ts: Date.now(),
      kind,
      source,
      data: data ? JSON.stringify(data).slice(0, 200) : null,
    });
    if (this.reflexLog.length > this.maxLog) this.reflexLog.shift();
    console.log(`[reflex] ${kind} → ${source}`);
  }

  getLog() {
    return this.reflexLog;
  }
}
