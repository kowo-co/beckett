/**
 * In-process coalescing for outbound Discord posts.
 *
 * One chilltext transform can still hit Discord twice: `DiscordJsGateway.post` re-queues after
 * a send that already landed, and auto-post / `beckett discord reply` can both call
 * `deliverChilled` with the same bubble. A key of (turn, channel, bubble) makes the second
 * caller wait for — and reuse — the first send instead of posting again.
 */

const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_DONE = 4_000;

export function outboundBubbleKey(turnId: string, channelId: string, bubbleIndex: number): string {
  return `${turnId}:${channelId}:${bubbleIndex}`;
}

/** Discord message nonce is a short opaque token; hash the full key down to 25 chars. */
export function discordNonceForKey(key: string): string {
  let h1 = 2166136261;
  let h2 = 2166136261;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c + i * 31;
    h2 = Math.imul(h2, 16777619);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  return (a + b).slice(0, 25);
}

export class OutboundDedupe {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly done = new Map<string, { id: string; at: number }>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  async run(key: string | undefined, send: () => Promise<string>): Promise<string> {
    if (!key) return send();
    this.prune();
    const cached = this.done.get(key);
    if (cached) return cached.id;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = Promise.resolve()
      .then(send)
      .then((id) => {
        this.done.set(key, { id, at: Date.now() });
        this.inflight.delete(key);
        this.trim();
        return id;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });
    this.inflight.set(key, p);
    return p;
  }

  remember(key: string, id: string): void {
    this.done.set(key, { id, at: Date.now() });
    this.inflight.delete(key);
    this.trim();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.done) {
      if (now - entry.at >= this.ttlMs) this.done.delete(key);
    }
  }

  private trim(): void {
    while (this.done.size > MAX_DONE) {
      const oldest = this.done.keys().next().value;
      if (oldest === undefined) break;
      this.done.delete(oldest);
    }
  }
}
