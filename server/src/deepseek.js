// deepseek.js — DeepSeek API client for reflex decisions
// Uses SiliconFlow (OpenAI-compatible endpoint) or direct DeepSeek API
// Falls back gracefully if no API key configured

import { config } from "./config.js";

const REFLEX_TIMEOUT = 8000; // 8 seconds max for reflex decision

export async function callReflexLLM(prompt) {
  if (!prompt) return null;

  // Try Hermes CLI first (has memory + skills), fall back to direct API
  try {
    const result = await callHermes(prompt);
    if (result) return result;
  } catch (e) {
    console.log("[reflex] hermes failed:", e.message);
  }

  // Fall back to direct DeepSeek/SiliconFlow API
  try {
    const result = await callDirectAPI(prompt);
    if (result) return result;
  } catch (e) {
    console.log("[reflex] direct API failed:", e.message);
  }

  return null;
}

// Call Hermes agent CLI — uses dont-starve profile for DST-specific memory/skills
async function callHermes(prompt) {
  const { execFile } = await import("node:child_process");
  const path = (await import("node:path")).default;
  const os = (await import("node:os")).default;

  const hermesBin = path.join(os.homedir(), ".hermes/hermes-agent/venv/bin/hermes");
  // Use dont-starve profile — has its own model, memory, skills, SOUL.md
  const userMsg = `DST survival reflex. ${prompt.system}\n\n${prompt.user}`;

  return new Promise((resolve) => {
    const proc = execFile(
      hermesBin,
      ["-p", "dont-starve", "-z", userMsg],
      {
        timeout: REFLEX_TIMEOUT,
        cwd: path.join(os.homedir(), ".hermes/profiles/dont-starve"),
        env: { ...process.env, HOME: os.homedir() },
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        // Try to parse JSON from stdout
        const text = stdout.trim();
        try {
          // Find JSON object in the response
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      }
    );
    // Kill if timeout
    setTimeout(() => {
      proc.kill("SIGTERM");
    }, REFLEX_TIMEOUT);
  });
}

// Direct API call to SiliconFlow / DeepSeek (no Hermes)
async function callDirectAPI(prompt) {
  const apiKey = config.deepseekKey;
  if (!apiKey) return null;

  const baseUrl = config.deepseekUrl;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFLEX_TIMEOUT);

  try {
    const res = await fetch(baseUrl, {
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
        max_tokens: 200,
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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      console.log("[reflex] API timeout");
    }
    return null;
  }
}
