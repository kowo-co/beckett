import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentMailClient } from "agentmail";
import { fenceUntrusted, headerLine, stripHtml } from "./render.ts";

const MAIL_STATE_VERSION = 1;
const BECKETT_MAIL_CLIENT_ID = "beckett-mail-v1";

type MailEnv = Record<string, string | undefined>;

/** Resolve the instance-owned mailbox; never discover a maintainer inbox by default. */
export function resolveMailAddress(env: MailEnv = process.env): string {
  const address = env.BECKETT_MAIL_ADDRESS?.trim();
  if (!address) {
    throw new Error(
      "BECKETT_MAIL_ADDRESS is not set — set it to this instance's AgentMail address",
    );
  }
  return address;
}

export interface MailInbox {
  inboxId: string;
  email: string;
  clientId?: string;
  metadata?: Record<string, unknown>;
}

export interface MailMessageItem {
  messageId: string;
  threadId: string;
  labels: string[];
  timestamp: Date | string;
  from: string;
  to: string[];
  subject?: string;
}

export interface MailMessage extends MailMessageItem {
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  text?: string;
  html?: string;
  extractedText?: string;
  extractedHtml?: string;
  headers?: Record<string, string>;
}

/** Small interface around the official SDK, so durable-state behavior is unit-testable. */
export interface AgentMailApi {
  inboxes: {
    list(request?: { limit?: number }): Promise<{ inboxes: MailInbox[] }>;
    create(request?: { clientId?: string; displayName?: string; metadata?: Record<string, boolean> }): Promise<MailInbox>;
    messages: {
      send(inboxId: string, request: { to: string; subject: string; text: string }): Promise<{ messageId: string; threadId: string }>;
      list(inboxId: string, request?: { limit?: number; labels?: string[] }): Promise<{ messages: MailMessageItem[] }>;
      get(inboxId: string, messageId: string): Promise<MailMessage>;
    };
  };
}

export interface MailState {
  version: 1;
  inboxId: string;
  address: string;
}

export function defaultMailStateFile(beckettDir: string): string {
  return join(beckettDir, "mail.json");
}

export function loadMailState(stateFile: string): MailState | null {
  if (!existsSync(stateFile)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (err) {
    throw new Error(`invalid mail state at ${stateFile}: ${(err as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>).version !== MAIL_STATE_VERSION ||
    typeof (parsed as Record<string, unknown>).inboxId !== "string" ||
    typeof (parsed as Record<string, unknown>).address !== "string"
  ) {
    throw new Error(`invalid mail state at ${stateFile}`);
  }
  return parsed as MailState;
}

export function saveMailState(stateFile: string, inbox: MailInbox): MailState {
  const state: MailState = { version: MAIL_STATE_VERSION, inboxId: inbox.inboxId, address: inbox.email };
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, stateFile);
  return state;
}

/**
 * Return the same inbox on subsequent invocations. With no local state, discover the inbox
 * created by AgentMail's agent onboarding (when it is the only inbox), otherwise find our
 * idempotent client-id marker or create a dedicated Beckett inbox.
 */
export async function bootstrapInbox(
  api: AgentMailApi,
  stateFile: string,
  mailAddress = resolveMailAddress(),
): Promise<MailState> {
  const configuredAddress = mailAddress.trim();
  if (!configuredAddress) {
    throw new Error(
      "BECKETT_MAIL_ADDRESS is not set — set it to this instance's AgentMail address",
    );
  }

  const saved = loadMailState(stateFile);
  if (saved) return saved;

  const listed = await api.inboxes.list({ limit: 100 });
  const marked = listed.inboxes.find(
    (inbox) => inbox.clientId === BECKETT_MAIL_CLIENT_ID || inbox.metadata?.beckett_mail === true,
  );
  // AgentMail onboarding provisioned this address before the CLI existed. Prefer it even when
  // another unrelated inbox is present, rather than accidentally creating a second mailbox.
  const configured = listed.inboxes.find((inbox) => inbox.email.toLowerCase() === configuredAddress.toLowerCase());
  const discovered = marked ?? configured ?? (listed.inboxes.length === 1 ? listed.inboxes[0] : undefined);
  const inbox = discovered ?? await api.inboxes.create({
    clientId: BECKETT_MAIL_CLIENT_ID,
    displayName: "Beckett",
    metadata: { beckett_mail: true },
  });
  return saveMailState(stateFile, inbox);
}

/** Create the official AgentMail Node SDK client. The key is passed, never logged. */
export function createAgentMailApi(apiKey: string): AgentMailApi {
  return new AgentMailClient({ apiKey }) as unknown as AgentMailApi;
}

export function isUnread(message: Pick<MailMessageItem, "labels">): boolean {
  return message.labels.some((label) => label.toLowerCase() === "unread");
}

function clip(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > width ? `${clean.slice(0, Math.max(0, width - 1))}…` : clean;
}

function tableCell(value: string, width: number): string {
  return clip(value, width).padEnd(width);
}

/** Render the compact inbox view requested by the CLI. */
export function renderMessageTable(messages: MailMessageItem[]): string {
  // AgentMail message IDs are deliberately long RFC-style identifiers. Never truncate them:
  // `ls` is where a caller obtains the exact ID needed by `mail read`.
  const idWidth = Math.max(18, ...messages.map((message) => message.messageId.length));
  const columns: Array<[string, number]> = [
    ["ID", idWidth],
    ["FROM", 26],
    ["SUBJECT", 38],
    ["DATE", 20],
    ["UNREAD", 6],
  ];
  const header = columns.map(([name, width]) => tableCell(name, width)).join("  ");
  const rule = columns.map(([, width]) => "-".repeat(width)).join("  ");
  const rows = messages.map((message) => [
    tableCell(message.messageId, idWidth),
    tableCell(message.from, 26),
    tableCell(message.subject || "(no subject)", 38),
    tableCell(formatDate(message.timestamp), 20),
    tableCell(isUnread(message) ? "yes" : "no", 6),
  ].join("  "));
  return [header, rule, ...(rows.length ? rows : ["(no messages)"])].join("\n");
}

function formatDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString().replace(".000Z", "Z");
}

/**
 * The HTML-to-text fallback lives in {@link ./render.ts} with the rest of the rendering rules;
 * re-exported here so this module's long-standing importers keep the same import site.
 */
export { stripHtml };

/**
 * Render full headers and a text-first body for `beckett mail read`.
 *
 * The body is wrapped by {@link fenceUntrusted}: an AgentMail message is third-party content
 * exactly like one that arrives through the domain intake, and this output can land in a model's
 * context as tool output, so it gets the same fence rather than a bare body.
 */
export function renderMessage(message: MailMessage): string {
  const headers: Array<[string, string | undefined]> = [
    ["Message-ID", message.messageId],
    ["Thread-ID", message.threadId],
    ["Date", formatDate(message.timestamp)],
    ["From", message.from],
    ["To", message.to.join(", ")],
    ["Cc", message.cc?.join(", ")],
    ["Bcc", message.bcc?.join(", ")],
    ["Reply-To", message.replyTo?.join(", ")],
    ["Subject", message.subject],
  ];
  for (const [name, value] of Object.entries(message.headers ?? {})) headers.push([name, value]);
  const renderedHeaders = headers
    .filter(([, value]) => value !== undefined && value !== "")
    // Collapsed to one bounded line each: a header value is attacker-controlled and is rendered
    // ABOVE the fence, so a raw newline in a Subject could otherwise forge frame structure here.
    .map(([name, value]) => `${name}: ${headerLine(String(value))}`);
  const body = message.text?.trim() || message.extractedText?.trim() || stripHtml(message.html || message.extractedHtml || "") || "(no body)";
  return [...renderedHeaders, "", fenceUntrusted(body)].join("\n");
}

/** Keep an API/server error useful while ensuring a key can never leak through an SDK error. */
export function safeMailError(err: unknown, apiKey: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split(apiKey).join("[redacted]");
}
