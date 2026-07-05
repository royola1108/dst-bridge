import { config } from "./config.js";

export class CommandQueue {
  constructor() {
    this.commands = new Map();
    this.order = [];
    this.priorityOrder = []; // say + interrupt go first
    this.leases = new Map();
  }

  enqueue(command, playerUserId) {
    if (this.order.length + this.priorityOrder.length >= config.maxQueueSize) {
      throw new Error("Command queue full");
    }
    const id = command.id || "cmd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const cmd = {
      ...command,
      id,
      playerUserId,
      status: "queued",
      enqueuedAt: Date.now(),
      onComplete: null,
    };
    this.commands.set(id, cmd);
    // say is instant and non-blocking — always go first
    const INSTANT_ACTIONS = new Set(["say"]);
    if (INSTANT_ACTIONS.has(cmd.action)) {
      this.priorityOrder.push(id);
    } else {
      this.order.push(id);
    }
    return cmd;
  }

  leaseBatch(playerUserId, maxCount = 8) {
    const leased = [];
    const remaining = [];
    const remainingPriority = [];

    // Priority commands first (say, etc.)
    for (const id of this.priorityOrder) {
      const cmd = this.commands.get(id);
      if (!cmd || cmd.playerUserId !== playerUserId) {
        if (cmd) remainingPriority.push(id);
        continue;
      }
      if (leased.length >= maxCount) {
        remainingPriority.push(id);
        continue;
      }
      cmd.status = "leased";
      cmd.leaseId = "lease-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      cmd.leasedAt = Date.now();
      cmd.leaseTimeoutMs = config.leaseTimeoutMs;
      this.leases.set(cmd.leaseId, id);
      leased.push(this._publicCmd(cmd));
    }

    // Normal commands
    for (const id of this.order) {
      const cmd = this.commands.get(id);
      if (!cmd || cmd.playerUserId !== playerUserId) {
        if (cmd) remaining.push(id);
        continue;
      }
      if (leased.length >= maxCount) {
        remaining.push(id);
        continue;
      }
      cmd.status = "leased";
      cmd.leaseId = "lease-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      cmd.leasedAt = Date.now();
      cmd.leaseTimeoutMs = config.leaseTimeoutMs;
      this.leases.set(cmd.leaseId, id);
      leased.push(this._publicCmd(cmd));
    }
    this.order = remaining;
    this.priorityOrder = remainingPriority;
    return leased;
  }

  ack(commandId, leaseId, status, reason, result) {
    const cmd = this.commands.get(commandId);
    if (!cmd) return null;
    if (leaseId) this.leases.delete(leaseId);
    cmd.status = status;
    cmd.reason = reason || null;
    cmd.result = result || null;
    cmd.completedAt = Date.now();
    if (cmd.onComplete) cmd.onComplete(cmd);
    return cmd;
  }

  checkTimeouts() {
    const now = Date.now();
    const timed = [];
    for (const [leaseId, cmdId] of this.leases) {
      const cmd = this.commands.get(cmdId);
      if (!cmd) {
        this.leases.delete(leaseId);
        continue;
      }
      if (now - cmd.leasedAt > cmd.leaseTimeoutMs) {
        cmd.status = "timeout";
        cmd.completedAt = now;
        this.leases.delete(leaseId);
        timed.push(cmd);
        if (cmd.onComplete) cmd.onComplete(cmd);
      }
    }
    return timed;
  }

  cancelAll(playerUserId) {
    const cancelled = [];
    const remaining = [];
    for (const queue of [this.priorityOrder, this.order]) {
      for (const id of queue) {
        const cmd = this.commands.get(id);
        if (!cmd) continue;
        if (cmd.playerUserId === playerUserId) {
          cmd.status = "cancelled";
          cmd.completedAt = Date.now();
          cancelled.push(id);
          if (cmd.onComplete) cmd.onComplete(cmd);
        } else {
          remaining.push(id);
        }
      }
    }
    this.order = remaining;
    this.priorityOrder = [];
    return cancelled;
  }

  getQueueInfo(playerUserId) {
    return [...this.commands.values()]
      .filter(
        (c) =>
          c.playerUserId === playerUserId &&
          ["queued", "leased", "executing"].includes(c.status)
      )
      .map((c) => ({ id: c.id, action: c.action, status: c.status, targetGuid: c.targetGuid }));
  }

  _publicCmd(cmd) {
    return {
      id: cmd.id,
      action: cmd.action,
      targetGuid: cmd.targetGuid ?? null,
      invObjectGuid: cmd.invObjectGuid ?? null,
      pos: cmd.pos ?? null,
      recipe: cmd.recipe ?? null,
      text: cmd.text ?? null,
      leaseId: cmd.leaseId,
      leaseTimeoutMs: cmd.leaseTimeoutMs,
      stateSeq: cmd.stateSeq ?? null,
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [id, cmd] of this.commands) {
      if (["done", "failed", "timeout", "cancelled"].includes(cmd.status)) {
        if (now - (cmd.completedAt || 0) > 300000) this.commands.delete(id);
      }
    }
  }
}
