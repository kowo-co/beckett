/**
 * Beckett v2 — control bus (`src/shell/control-bus.ts`)
 * =======================================================================================
 * The thin request/response channel between the `beckett` CLI (which the parent agent runs
 * via Bash) and the long-lived shell process that holds the live worker handles + the
 * parent's stdin pipe (Spec 05). A unix-domain socket, one request per connection, framed
 * with a 4-byte big-endian length prefix + UTF-8 JSON.
 *
 * This is deliberately self-contained (no dependency on the v0.1 IPC command union, which is
 * being deleted): the envelope is just `{cmd, args}` → `{ok, data?, error?}`. The shell owns
 * the command vocabulary; the CLI is a dumb forwarder.
 */

import { existsSync, unlinkSync } from "node:fs";

const HEADER = 4;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface BusRequest {
  cmd: string;
  args: Record<string, unknown>;
  /**
   * Issuer credential (OPS-80 §9.3): the concierge exports a per-session secret into each child's
   * env as `BECKETT_SESSION_TOKEN`; `callBus` echoes it back here so the daemon can correlate a
   * bus op to the exact session whose turn issued it — never to whichever turn happens to be live
   * in the op's target channel. Absent for human/operator CLI use.
   */
  token?: string;
  /**
   * Set by `callBus` on every request that carries no {@link token}: a bare `beckett` CLI
   * invocation — a human at a shell, a deploy script, cron — that dialed the daemon's own
   * control socket directly rather than riding a live concierge session's turn. The socket
   * itself is the trust boundary (only local processes with filesystem access can reach it),
   * so a handler that opts into `operator` is choosing to trust that boundary in place of a
   * Discord `(userId, channelId)` pair. Only capabilities that explicitly branch on it (see
   * `browser.steer`/`browser.stop` in `concierge/index.ts`) treat it as authorization; every
   * other tokenless caller keeps the existing `currentMention` fallback.
   */
  operator?: boolean;
}
export interface BusResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * The caller did not receive a response before its deadline, so the outcome is unknown: the daemon
 * may still be working on it (and, for a Discord reply, may already have posted it). Callers must not turn this
 * into an automatic retry of a side-effecting command.
 */
export class ControlBusTimeoutError extends Error {
  readonly code = "CONTROL_BUS_TIMEOUT";
  constructor(readonly timeoutMs: number) {
    super(`control bus timeout after ${timeoutMs}ms`);
    this.name = "ControlBusTimeoutError";
  }
}

/**
 * Render a control-bus timeout as an INDETERMINATE outcome for a human/model reader (issue #137). A
 * timeout means the CLI STOPPED WAITING, never that the work failed: the daemon may have accepted the
 * request and may already have carried it out (posted the reply, started the run). So the message says
 * the outcome is unknown, forbids an automatic retry of a side-effecting dispatch, and names the exact
 * command that settles the true state. Callers print this instead of the bare `control bus timeout`
 * error string — nonzero exit is fine, but the wording must never read as "it did not happen".
 */
export function indeterminateBusTimeout(err: ControlBusTimeoutError, checkWith: string): string {
  return (
    `INDETERMINATE: the control bus stopped waiting after ${err.timeoutMs}ms — this is NOT a failure. ` +
    `The daemon may have accepted this and may already have finished it, so do NOT retry automatically. ` +
    `Confirm the real outcome with: ${checkWith}`
  );
}

function frame(value: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(HEADER + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, HEADER);
  return out;
}

/** Decode exactly one length-prefixed frame from an accumulating buffer. */
class OneFrame {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): unknown | undefined {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    if (this.buf.length < HEADER) return undefined;
    const len = new DataView(this.buf.buffer, this.buf.byteOffset, HEADER).getUint32(0, false);
    if (this.buf.length < HEADER + len) return undefined;
    try {
      return JSON.parse(dec.decode(this.buf.subarray(HEADER, HEADER + len)));
    } catch {
      return undefined;
    }
  }
}

export type BusHandler = (req: BusRequest) => Promise<BusResponse> | BusResponse;

/** Listen on a unix socket; dispatch each `{cmd,args}` to `handler`. Returns a stop fn. */
export function serveBus(socketPath: string, handler: BusHandler): () => void {
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      /* stale socket */
    }
  }
  const frames = new WeakMap<object, OneFrame>();
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(sock, data) {
        let fd = frames.get(sock);
        if (!fd) frames.set(sock, (fd = new OneFrame()));
        const msg = fd.push(data);
        if (msg === undefined) return;
        const req = msg as BusRequest;
        Promise.resolve(handler(req))
          .then((res) => sock.write(frame(res)))
          .catch((err) => sock.write(frame({ ok: false, error: String(err?.message ?? err) })))
          .finally(() => queueMicrotask(() => sock.end()));
      },
    },
  });
  return () => {
    try {
      server.stop(true);
    } catch {
      /* best-effort */
    }
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        /* best-effort */
      }
    }
  };
}

/** One-shot client call from the CLI to the shell. Rejects if the socket is absent/refused. */
export function callBus(
  socketPath: string,
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<BusResponse> {
  return new Promise((resolve, reject) => {
    const fd = new OneFrame();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new ControlBusTimeoutError(timeoutMs))),
      timeoutMs,
    );
    // Stamp the issuer credential when running inside a concierge session's child (see BusRequest).
    const token = process.env.BECKETT_SESSION_TOKEN || undefined;
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(frame(token ? { cmd, args, token } : { cmd, args, operator: true }));
        },
        data(sock, data) {
          const msg = fd.push(data);
          if (msg === undefined) return;
          clearTimeout(timer);
          sock.end();
          done(() => resolve(msg as BusResponse));
        },
        error(_sock, err) {
          clearTimeout(timer);
          done(() => reject(err));
        },
        connectError(_sock, err) {
          clearTimeout(timer);
          done(() =>
            reject(new Error(`shell not running (socket ${socketPath}): ${err?.message ?? err}`)),
          );
        },
      },
    }).catch((err) => {
      clearTimeout(timer);
      done(() => reject(err));
    });
  });
}
