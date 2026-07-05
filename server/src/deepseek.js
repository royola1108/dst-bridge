// deepseek.js — Reflex LLM client
// Primary: Hermes API server (sync, has DST memory/skills/SOUL.md)
// Fallback: direct SiliconFlow / DeepSeek API (stateless, fast)

import { config } from "./config.js";

const REFLEX_TIMEOUT = 20000; // 20s — Hermes agent loop needs time for memory

export async function callReflexLLM(prompt) {
  if (!prompt) return null;

  // Try Hermes API server first (has memory + skills + SOUL.md)
  try {
    const result = await callHermesApi(prompt);
    if (result) {
      console.log("[reflex] hermes responded");
      return result;
    }
  } catch (e) {
    console.log("[reflex] hermes failed:", e.message);
  }

  // Fall back to direct DeepSeek/SiliconFlow API (stateless)
  try {
    const result = await callDirectAPI(prompt);
    if (result) {
      console.log("[reflex] direct API responded");
      return result;
    }
  } catch (e) {
    console.log("[reflex] direct API failed:", e.message);
  }

  return null;
}

// Call Hermes API server — OpenAI-compatible, sync, runs through gateway agent loop
// Has dont-starve profile memory, skills, and SOUL.md loaded
async function callHermesApi(prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFLEX_TIMEOUT);

  try {
    const res = await fetch(config.hermesApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.hermesApiKey}`,
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`[reflex] hermes API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    return parseActionJson(text);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      console.log("[reflex] hermes timeout");
    }
    return null;
  }
}

// Direct API call to SiliconFlow / DeepSeek (no Hermes, no memory)
async function callDirectAPI(prompt) {
  const apiKey = config.deepseekKey;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFLEX_TIMEOUT);

  try {
    const res = await fetch(config.deepseekUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-V3",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`[reflex] API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    return parseActionJson(text);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      console.log("[reflex] API timeout");
    }
    return null;
  }
}

// Parse LLM response text — handles markdown code blocks, natural language wrappers
// Maps common action name variants to our action system
function parseActionJson(text) {
  if (!text) return null;

  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // Find JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  // Normalize action names
  const ACTION_MAP = {
    move_to: "walk_to",
    walk: "walk_to",
    goto: "walk_to",
    go_to: "walk_to",
    pickup: "pickup",
    pick_up: "pickup",
    gather: "pickup",
    chop: "chop",
    mine: "mine",
    dig: "dig",
    build: "build",
    craft: "craft",
    eat: "eat",
    equip: "equip",
    attack: "attack",
    flee: "walk_to",
    run: "walk_to",
  };

  if (parsed.action && ACTION_MAP[parsed.action]) {
    parsed.action = ACTION_MAP[parsed.action];
  }

  // If action is "walk_to" but has a target name instead of pos, mark as needs resolution
  if (parsed.action === "walk_to" && parsed.target && !parsed.pos) {
    parsed.needsTargetResolution = parsed.target;
    delete parsed.target;
  }

  // Must have a recognized action or escalate
  if (!parsed.action && !parsed.escalate) {
    return null;
  }

  return parsed;
}
