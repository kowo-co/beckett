/**
 * Beckett — branch preview (`src/preview/index.ts`)
 * =======================================================================================
 * Reviewing a frontend change by reading a diff is a poor substitute for opening the page. This
 * gives every branch that TOUCHES A FRONTEND a reachable preview URL while it is in review, torn
 * down the moment it lands (done) or is cancelled.
 *
 * It deliberately does NOT build a PaaS. Serving is done by the machinery that already exists: the
 * worker, which has the built app in its worktree, stands the preview up on a durable local port
 * and publishes it with `beckett deploy <slug>-preview` (the same tunnel + DNS path documented in
 * the deploy skill), exactly as it already deploys any public URL. This module owns the SYSTEM's
 * half of the contract:
 *   - {@link isFrontendChange} — does this branch's diff touch a browser-facing frontend?
 *   - {@link previewNameFor} — the DETERMINISTIC preview host, so the daemon knows where the worker
 *     deployed without the worker reporting it back.
 *   - {@link PreviewManager.ensure} — while in review: probe that deterministic host and, ONLY if it
 *     actually responds AND is externally routable, record it on the ticket and hand it back to be
 *     surfaced. An unreachable or internal host is never surfaced (the #49 veto).
 *   - {@link PreviewManager.teardown} — on land/cancel: remove the tunnel ingress + DNS record. The
 *     worker's worktree is long gone by then, so the daemon owns cleanup.
 */

import type { Logger } from "../types.ts";
import type { TunnelDeployer } from "../shell/deploy.ts";
import { DEFAULT_APEX_DOMAIN } from "../agency/cloudflare.ts";
import { isExternalHttpUrl } from "../net/url-safety.ts";

// =======================================================================================
// Frontend detection
// =======================================================================================

/** File extensions that only appear in browser-facing frontend work. */
const FRONTEND_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl",
  ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".mdx",
]);

/** Basenames that mark a project as having a frontend build/toolchain, wherever they sit. */
const FRONTEND_CONFIG_FILES = new Set([
  "index.html",
  "vite.config.ts", "vite.config.js", "vite.config.mjs",
  "next.config.js", "next.config.mjs", "next.config.ts",
  "tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs",
  "svelte.config.js", "astro.config.mjs", "astro.config.ts",
  "nuxt.config.ts", "nuxt.config.js", "postcss.config.js", "postcss.config.cjs",
  "remix.config.js", "angular.json",
]);

/** Top-level-ish directory names that hold frontend source (paired with a code/asset extension). */
const FRONTEND_DIRS = new Set([
  "web", "frontend", "front-end", "ui", "client", "webapp", "web-app",
  "site", "public", "static", "assets", "components", "pages", "views", "styles",
]);

/** Code/asset extensions that count as frontend ONLY when they live under a {@link FRONTEND_DIRS} dir. */
const FRONTEND_DIR_EXTENSIONS = new Set([
  ".js", ".ts", ".mjs", ".cjs", ".json", ".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".ico", ".woff", ".woff2",
]);

function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True when a single changed path is browser-facing frontend work. */
export function isFrontendPath(path: string): boolean {
  const clean = path.trim().replace(/^\.\//, "");
  if (!clean) return false;
  if (FRONTEND_CONFIG_FILES.has(basename(clean))) return true;
  const ext = extname(clean);
  if (FRONTEND_EXTENSIONS.has(ext)) return true;
  if (FRONTEND_DIR_EXTENSIONS.has(ext)) {
    const segments = clean.split("/");
    // Any directory segment (not the file itself) being a known frontend dir counts.
    if (segments.slice(0, -1).some((seg) => FRONTEND_DIRS.has(seg.toLowerCase()))) return true;
  }
  return false;
}

/**
 * True when a branch's set of changed files touches a browser-facing frontend — the gate for
 * whether it earns a preview. Conservative: a lone `package.json` or backend `.ts` edit is NOT a
 * frontend change; a `.tsx`/`.css`/`index.html`/`vite.config` edit, or a code/asset file under a
 * `web/`-style dir, is.
 */
export function isFrontendChange(files: readonly string[]): boolean {
  return files.some(isFrontendPath);
}

// =======================================================================================
// Deterministic preview host
// =======================================================================================

/**
 * The tunnel deploy NAME (a bare label, not a full hostname) for a branch's preview. Deterministic
 * from the ticket's project slug so the daemon can probe and tear down exactly where the worker
 * deployed, with no round-trip. `<slug>-preview` → `<slug>-preview.<apex>`.
 */
export function previewNameFor(slug: string): string {
  const clean = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  return `${clean}-preview`;
}

// =======================================================================================
// Preview manager
// =======================================================================================

/** The minimal ticket identity the manager needs — decoupled from the tracker `Ticket` type. */
export interface PreviewTicket {
  /** Tracker ticket id (for logging only). */
  id: string;
  /** The ticket's project slug — the worker's repo AND public-hostname name. */
  slug: string;
  /** The `#N.x` branch ref, when the ticket is bound to a task branch (for recording). */
  branchRef?: string;
}

/** Where a surfaced preview is recorded so it survives worktree teardown and shows on the ticket. */
export interface PreviewStore {
  setPreview(branchRef: string, preview: { url: string; host: string }): Promise<unknown>;
  clearPreview(branchRef: string): Promise<unknown>;
}

export type PreviewOutcome =
  | { status: "ready"; url: string; host: string }
  | { status: "skipped"; reason: string };

export interface PreviewManagerDeps {
  /** The tunnel deployer — used ONLY to tear down (remove ingress + DNS). Serving is the worker's job. */
  deployer: Pick<TunnelDeployer, "available" | "remove">;
  /** Reachability probe: true only when the URL actually responds. Injected (tests / real fetch). */
  probe: (url: string) => Promise<boolean>;
  /** The branch's changed files, resolved lazily so detection only runs when a preview is possible. */
  changedFiles: (ticket: PreviewTicket) => Promise<readonly string[]>;
  /** Optional durable record of the surfaced URL, keyed by branch ref. */
  store?: PreviewStore;
  logger: Logger;
  /** Zone apex the preview host lives under. Defaults to this install's zone. */
  apex?: string;
  /** How many times to poll the deterministic host before giving up (DNS/tunnel propagation). */
  probeAttempts?: number;
  /** Backoff between probe attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay between probe attempts in ms. */
  probeDelayMs?: number;
}

/**
 * Owns the system half of branch previews: verify-and-surface while in review, tear down on
 * land/cancel. Stateless across calls (all state lives on the tracker/task registry), so a daemon
 * restart mid-review re-derives the same deterministic host and simply re-probes.
 */
export class PreviewManager {
  private readonly deployer: Pick<TunnelDeployer, "available" | "remove">;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly changedFiles: (ticket: PreviewTicket) => Promise<readonly string[]>;
  private readonly store?: PreviewStore;
  private readonly logger: Logger;
  private readonly apex: string;
  private readonly probeAttempts: number;
  private readonly probeDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: PreviewManagerDeps) {
    this.deployer = deps.deployer;
    this.probe = deps.probe;
    this.changedFiles = deps.changedFiles;
    this.store = deps.store;
    this.logger = deps.logger;
    this.apex = deps.apex ?? DEFAULT_APEX_DOMAIN;
    this.probeAttempts = Math.max(1, deps.probeAttempts ?? 3);
    this.probeDelayMs = deps.probeDelayMs ?? 4000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** `<slug>-preview.<apex>` — the full hostname the worker deployed to. */
  hostnameFor(slug: string): string {
    return `${previewNameFor(slug)}.${this.apex}`;
  }

  private urlFor(slug: string): string {
    return `https://${this.hostnameFor(slug)}`;
  }

  /**
   * While a frontend branch is in review: probe its deterministic preview host and, only if it
   * ACTUALLY responds AND is externally routable, record it and return it to be surfaced. Never
   * surfaces an unreachable or internal URL (the #49 veto) — those return `skipped`, and the caller
   * posts nothing. Idempotent and side-effect-light: safe to call again on a re-poll of in_review.
   */
  async ensure(ticket: PreviewTicket): Promise<PreviewOutcome> {
    // No tunnel configured → the worker could not have deployed anywhere reachable; surface nothing.
    if (!this.deployer.available) return { status: "skipped", reason: "tunnel not configured" };

    let files: readonly string[];
    try {
      files = await this.changedFiles(ticket);
    } catch (err) {
      this.logger.warn("preview: changed-file resolution failed; skipping", {
        ticket: ticket.id,
        error: (err as Error).message,
      });
      return { status: "skipped", reason: "could not read the branch diff" };
    }
    if (!isFrontendChange(files)) return { status: "skipped", reason: "no frontend changes" };

    const host = this.hostnameFor(ticket.slug);
    const url = this.urlFor(ticket.slug);
    // Defense in depth: the deterministic host is public by construction, but never surface a URL
    // the Discord boundary would strip.
    if (!isExternalHttpUrl(url)) return { status: "skipped", reason: "preview url is not externally routable" };

    if (!(await this.reachable(url))) {
      // The worker didn't deploy, or it isn't up yet / not routable. Honest silence, not a dead link.
      this.logger.info("preview: deterministic host did not respond; not surfacing", { ticket: ticket.id, url });
      return { status: "skipped", reason: "preview did not respond" };
    }

    if (this.store && ticket.branchRef) {
      try {
        await this.store.setPreview(ticket.branchRef, { url, host });
      } catch (err) {
        this.logger.warn("preview: recording on task branch failed (still surfacing)", {
          ticket: ticket.id,
          error: (err as Error).message,
        });
      }
    }
    this.logger.info("preview surfaced", { ticket: ticket.id, url });
    return { status: "ready", url, host };
  }

  /**
   * On land/cancel: remove the preview's tunnel ingress + DNS record and clear its recorded URL.
   * Idempotent — a preview that was never stood up (no frontend, unreachable, no tunnel) tears down
   * cleanly to a no-op. Never throws: teardown is best-effort cleanup on a terminal transition.
   */
  async teardown(ticket: PreviewTicket): Promise<void> {
    if (this.deployer.available) {
      const name = previewNameFor(ticket.slug);
      try {
        await this.deployer.remove(name);
      } catch (err) {
        this.logger.warn("preview teardown: tunnel remove failed", {
          ticket: ticket.id,
          error: (err as Error).message,
        });
      }
    }
    if (this.store && ticket.branchRef) {
      try {
        await this.store.clearPreview(ticket.branchRef);
      } catch (err) {
        this.logger.warn("preview teardown: clearing task branch record failed", {
          ticket: ticket.id,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Poll the URL up to `probeAttempts` times, backing off between tries, until it responds. */
  private async reachable(url: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.probeAttempts; attempt++) {
      if (attempt > 0) await this.sleep(this.probeDelayMs);
      try {
        if (await this.probe(url)) return true;
      } catch (err) {
        this.logger.debug?.("preview probe threw", { url, error: (err as Error).message });
      }
    }
    return false;
  }
}
