export class StateCache {
  constructor() {
    this.slots = new Map();
    this.maxEvents = 100;
  }

  get(playerUserId) {
    return this.slots.get(playerUserId) || this._createSlot(playerUserId);
  }

  _createSlot(playerUserId) {
    const slot = {
      playerUserId,
      current: null,
      lastUpdate: 0,
      seq: 0,
      events: [],
      eventSeq: 0,
    };
    this.slots.set(playerUserId, slot);
    return slot;
  }

  update(playerUserId, seq, state) {
    const slot = this.get(playerUserId);
    slot.current = state;
    slot.lastUpdate = Date.now();
    slot.seq = seq;
    return slot;
  }

  addEvent(playerUserId, event) {
    const slot = this.get(playerUserId);
    event.seq = ++slot.eventSeq;
    event.ts = event.ts || Date.now();
    slot.events.push(event);
    if (slot.events.length > this.maxEvents) slot.events.shift();
    return event;
  }

  getEvents(playerUserId, since, limit = 20) {
    const slot = this.get(playerUserId);
    let events = slot.events;
    if (since != null) events = events.filter((e) => e.seq > since);
    return events.slice(-limit);
  }

  isConnected(playerUserId) {
    const slot = this.slots.get(playerUserId);
    if (!slot) return false;
    return slot.current && Date.now() - slot.lastUpdate < 10000;
  }

  getDefaultPlayer() {
    for (const [userid, slot] of this.slots) {
      if (slot.current) return userid;
    }
    return null;
  }

  cleanup() {
    const now = Date.now();
    for (const [userid, slot] of this.slots) {
      if (!slot.current && now - slot.lastUpdate > 60000 && slot.events.length === 0) {
        this.slots.delete(userid);
      }
    }
  }
}
