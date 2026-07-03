import { config } from "./config.js";
import { StateCache } from "./state.js";
import { CommandQueue } from "./queue.js";
import {
  formatState,
  formatNearby,
  formatInventory,
  formatEvents,
  formatQueue,
  formatStatus,
  formatDoResult,
  formatCancelResult,
} from "./format.js";

export function createServer() {
  const stateCache = new StateCache();
  const queue = new CommandQueue();
  let startTime = Date.now();
  let totalProcessed = 0;

  setInterval(() => queue.checkTimeouts(), 2000);
  setInterval(() => stateCache.cleanup(), 60000);
  setInterval(() => queue.cleanup(), 60000);

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (!body) return {};
    try {
      // DST's json.encode escapes single quotes as \' which is invalid JSON
      const fixed = body.replace(/\\'/g, "'");
      return JSON.parse(fixed);
    } catch (e) {
      console.error("[bridge] JSON parse error:", e.message, "body[:200]:", body.slice(0, 200));
      throw e;
    }
  }

  function sendJson(res, code, data) {
    const json = JSON.stringify(data);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(json);
  }

  function sendText(res, code, text) {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
  }

  function resolvePlayer(args, query) {
    if (args.playerUserId) return args.playerUserId;
    if (query.playerUserId) return query.playerUserId;
    return stateCache.getDefaultPlayer() || "default";
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const method = req.method || "GET";

    try {
      // ─── DST Mod endpoints ───
      if (path === "/tick" && method === "POST") {
        const body = await readBody(req);
        console.log("[bridge] /tick received, playerUserId:", body.playerUserId, "seq:", body.seq);
        const puid = body.playerUserId || "default";
        stateCache.update(puid, body.seq, body.state);

        if (body.executingResults) {
          for (const r of body.executingResults) {
            queue.ack(r.id, r.leaseId, r.status, r.reason, r.result);
            totalProcessed++;
          }
        }

        const commands = queue.leaseBatch(puid);
        sendJson(res, 200, {
          ok: true,
          ackSeq: body.seq,
          commands,
          config: {
            pollInterval: config.pollInterval,
            perceptionRadius: config.perceptionRadius,
            maxNearbyEntities: config.maxNearbyEntities,
            leaseTimeoutMs: config.leaseTimeoutMs,
          },
        });
        return;
      }

      if (path === "/result" && method === "POST") {
        const body = await readBody(req);
        queue.ack(body.id, body.leaseId, body.status, body.reason, body.result);
        totalProcessed++;
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/event" && method === "POST") {
        const body = await readBody(req);
        const puid = body.playerUserId || "default";
        stateCache.addEvent(puid, { kind: body.kind, data: body.data, ts: body.ts });
        // TODO: Phase 3 reflex engine hook
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/config" && method === "GET") {
        sendJson(res, 200, {
          pollInterval: config.pollInterval,
          perceptionRadius: config.perceptionRadius,
          maxNearbyEntities: config.maxNearbyEntities,
          enableEvents: true,
          leaseTimeoutMs: config.leaseTimeoutMs,
        });
        return;
      }

      // ─── CLI endpoints (/api/*) ───
      if (path.startsWith("/api/") && method === "POST") {
        const tool = path.slice(5).split("?")[0];
        const body = await readBody(req);
        const puid = resolvePlayer(body, Object.fromEntries(url.searchParams));

        switch (tool) {
          case "state":
            sendText(res, 200, formatState(stateCache.get(puid)));
            return;

          case "nearby":
            sendText(res, 200, formatNearby(stateCache.get(puid), body));
            return;

          case "inventory":
          case "inv":
            sendText(res, 200, formatInventory(stateCache.get(puid)));
            return;

          case "events":
            sendText(
              res,
              200,
              formatEvents(stateCache.get(puid), body.since, body.limit || 20)
            );
            return;

          case "status": {
            const uptime = Date.now() - startTime;
            sendText(res, 200, formatStatus(stateCache, queue, puid, uptime, totalProcessed, config.port));
            return;
          }

          case "queue":
            sendText(res, 200, formatQueue(queue, puid));
            return;

          case "do": {
            const cmd = queue.enqueue(
              {
                action: body.action,
                targetGuid: body.targetGuid,
                invObjectGuid: body.invObjectGuid,
                pos: body.pos,
                recipe: body.recipe,
                stateSeq: stateCache.get(puid).seq,
              },
              puid
            );
            sendText(res, 200, formatDoResult(cmd));
            return;
          }

          case "cancel":
          case "interrupt": {
            const cancelled = queue.cancelAll(puid);
            sendText(res, 200, formatCancelResult(cancelled));
            return;
          }

          // Phase 2 stubs — return "not yet implemented"
          case "situation":
          case "goal":
          case "goals":
          case "wait":
            sendText(res, 501, `(not yet implemented: ${tool})`);
            return;

          default:
            sendText(res, 404, `Unknown tool: ${tool}`);
            return;
        }
      }

      if (path === "/" || path === "/healthz") {
        sendJson(res, 200, { ok: true, uptime: Date.now() - startTime });
        return;
      }

      sendText(res, 404, "Not found. Use /tick, /result, /event, /config, /api/<tool>");
    } catch (e) {
      sendText(res, 500, `Error: ${e.message}`);
    }
  }

  return {
    listen: async () => {
      const { createServer: http } = await import("node:http");
      const srv = http((req, res) => {
        handleRequest(req, res).catch((e) => {
          res.writeHead(500);
          res.end(`Error: ${e.message}`);
        });
      });
      srv.listen(config.port, "127.0.0.1", () => {
        console.log(`[dst-bridge] server ready on port ${config.port}`);
        console.log(`  DST endpoints: POST /tick, /result, /event; GET /config`);
        console.log(`  CLI endpoints: POST /api/{state,nearby,inv,events,do,queue,cancel,status}`);
        console.log(`  Health:        GET /healthz`);
      });
      return srv;
    },
  };
}

// Auto-start when run directly (node src/index.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = createServer();
  s.listen();
}
