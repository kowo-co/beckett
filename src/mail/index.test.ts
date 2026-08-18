import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootstrapInbox,
  renderMessage,
  renderMessageTable,
  safeMailError,
  stripHtml,
  type AgentMailApi,
} from "./index.ts";
import { MAIL_FENCE_CLOSE } from "./render.ts";

const temps: string[] = [];
function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "beckett-mail-"));
  temps.push(dir);
  return join(dir, "mail.json");
}
afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fakeApi(inboxes: Array<{ inboxId: string; email: string; clientId?: string }> = []): AgentMailApi {
  return {
    inboxes: {
      list: async () => ({ inboxes }),
      create: async () => ({ inboxId: "created-id", email: "beckett@agentmail.to", clientId: "beckett-mail-v1" }),
      messages: {
        send: async () => ({ messageId: "message-id", threadId: "thread-id" }),
        list: async () => ({ messages: [] }),
        get: async () => ({
          messageId: "message-id", threadId: "thread-id", labels: [], timestamp: "2026-01-01T00:00:00Z",
          from: "sender@example.com", to: ["beckett@agentmail.to"], subject: "Hello",
        }),
      },
    },
  };
}

describe("AgentMail inbox bootstrap", () => {
  test("creates a marked inbox once and persists only its id and address", async () => {
    const file = stateFile();
    let creates = 0;
    const api = fakeApi();
    api.inboxes.create = async () => {
      creates++;
      return { inboxId: "created-id", email: "beckett@agentmail.to" };
    };
    expect(await bootstrapInbox(api, file, "beckett@agentmail.to")).toEqual({ version: 1, inboxId: "created-id", address: "beckett@agentmail.to" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, inboxId: "created-id", address: "beckett@agentmail.to" });
    expect(await bootstrapInbox(api, file, "beckett@agentmail.to")).toEqual({ version: 1, inboxId: "created-id", address: "beckett@agentmail.to" });
    expect(creates).toBe(1);
  });

  test("discovers AgentMail's single auto-provisioned inbox", async () => {
    const file = stateFile();
    const state = await bootstrapInbox(fakeApi([{ inboxId: "onboarded", email: "agent@agentmail.to" }]), file, "agent@agentmail.to");
    expect(state).toEqual({ version: 1, inboxId: "onboarded", address: "agent@agentmail.to" });
  });

  test("prefers the configured inbox when AgentMail has multiple inboxes", async () => {
    const state = await bootstrapInbox(fakeApi([
      { inboxId: "other", email: "other@agentmail.to" },
      { inboxId: "agent", email: "agent@agentmail.to" },
    ]), stateFile(), "agent@agentmail.to");
    expect(state).toEqual({ version: 1, inboxId: "agent", address: "agent@agentmail.to" });
  });

  test("requires an explicit instance-owned AgentMail address", async () => {
    await expect(bootstrapInbox(fakeApi(), stateFile(), "")).rejects.toThrow(
      "BECKETT_MAIL_ADDRESS is not set — set it to this instance's AgentMail address",
    );
  });
});

test("message output is compact and read output prefers text", () => {
  const table = renderMessageTable([{
    messageId: "m-1", threadId: "t-1", labels: ["unread"], timestamp: "2026-01-01T00:00:00Z",
    from: "sender@example.com", to: ["agent@example.com"], subject: "Verification code",
  }]);
  expect(table).toContain("FROM");
  expect(table).toContain("yes");
  const longId = "<0100019f626fd7de-very-long-id@agentmail.to>";
  expect(renderMessageTable([{
    messageId: longId, threadId: "t-1", labels: [], timestamp: "2026-01-01T00:00:00Z",
    from: "sender@example.com", to: ["agent@example.com"], subject: "Long ID",
  }])).toContain(longId);

  const rendered = renderMessage({
    messageId: "m-1", threadId: "t-1", labels: [], timestamp: "2026-01-01T00:00:00Z",
    from: "sender@example.com", to: ["agent@example.com"], cc: ["cc@example.com"], bcc: ["bcc@example.com"], subject: "Hi",
    text: "plain text", html: "<p>html text</p>", headers: { "X-Test": "value" },
  });
  expect(rendered).toContain("X-Test: value");
  expect(rendered).toContain("Bcc: bcc@example.com");
  // The body is third-party content, so it comes back fenced behind the gutter rather than bare —
  // this output can land in a model's context as tool output. Text is still preferred over html.
  expect(rendered).toContain("  | plain text");
  expect(rendered).not.toContain("html text");
  expect(rendered).toEndWith(MAIL_FENCE_CLOSE);
  expect(stripHtml("<p>Hello<br>world</p><script>bad()</script>")).toBe("Hello\nworld");
});

test("API keys are redacted from surfaced SDK errors", () => {
  expect(safeMailError(new Error("Bearer am_secret failed"), "am_secret")).not.toContain("am_secret");
});
