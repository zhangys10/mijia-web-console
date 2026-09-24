import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("assistant button is a labeled floating entry that guides login when disconnected", async () => {
  const source = await read("../app/components/ai-assistant/ai-assistant-button.tsx");
  assert.match(source, /aria-label="AI 助手"/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /aria-controls="ai-assistant-panel"/);
  assert.match(source, /type="button"/);
  assert.match(source, /if \(!connected\) \{\s*onOpenLogin\(\);/, "logged-out clicks must open the existing Xiaomi login instead of the panel");
  assert.match(source, /homeId !== "demo"/, "the assistant must never open against the demo home");
  assert.match(source, /key=\{homeId\}/, "switching homes must reset the home-bound conversation handle");
  assert.match(source, /ai-assistant-button\$\{open \? " is-open" : ""\}/, "the launcher must yield to the panel it opened");
  assert.match(source, /buttonRef\.current\?\.focus\(\)/, "closing the panel must return focus to the launcher");
  const styles = await read("../app/ai-assistant.css");
  assert.match(styles, /\.ai-assistant-button\.is-open\{visibility:hidden/, "the launcher must not cover the composer send button while the panel is open");
});

test("assistant panel is an accessible dialog with escape close and honest clear-conversation copy", async () => {
  const source = await read("../app/components/ai-assistant/ai-assistant-panel.tsx");
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-label="AI 助手对话"/);
  assert.match(source, /tabIndex=\{-1\}/, "the dialog must take focus when it opens");
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /aria-label="关闭 AI 助手"/);
  assert.match(source, /仅清除对话记忆，不影响设备与场景/, "clear-conversation must state it only clears conversation memory");
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /\/api\/ai\/conversations\/\$\{encodeURIComponent\(conversationId\)\}/);
  assert.match(source, /"use client"/);
});

test("chat requests stay single-flight, idempotent, and abortable without auto-retry", async () => {
  const source = await read("../app/components/ai-assistant/ai-assistant-panel.tsx");
  assert.match(source, /if \(!message \|\| sending \|\| resetting \|\| !homeId\) return;/, "sending must guard duplicate submissions");
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /abortRef\.current\?\.abort\(\)/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /idempotencyKey: crypto\.randomUUID\(\)/, "each turn must send a per-turn idempotency key");
  assert.match(source, /请勿立即重发同一指令/, "abort copy must admit the server may still finish the turn");
  assert.match(source, /恢复前不会自动重试/);
  assert.match(source, /list\[list\.length - 1\]/);
  assert.match(source, /list\.slice\(0, -1\)/, "a failed turn must be rolled back so retry does not duplicate the user message");
  const sendCalls = source.match(/void send\(/g) ?? [];
  assert.equal(sendCalls.length, 3, "send must only ever run from the suggestion, composer, and retry affordances — never automatically");
});

test("quota rendering never presents disabled quota as zero remaining", async () => {
  const source = await read("../app/components/ai-assistant/ai-assistant-panel.tsx");
  assert.match(source, /if \(!quota\) return "配额信息不可用"/);
  assert.match(source, /quota\.mode === "disabled"\) return "配额已停用\/不可用"/);
  assert.match(source, /quota\.mode === "unlimited"\) return "配额不限"/);
  assert.match(source, /今日剩余 \$\{quota\.remainingRequestsToday \?\? "—"\} 次/);
  assert.match(source, /AI_QUOTA_EXCEEDED/);
  assert.match(source, /retryAfter/, "the 429 branch must surface the recovery time");
  assert.match(source, /window\.setTimeout\(\(\) => setRetryAfterAt\(undefined\)/, "cooldown expiry may only re-enable the retry button");
});

test("message list announces updates politely and renders honest scene and tool results", async () => {
  const source = await read("../app/components/ai-assistant/ai-message-list.tsx");
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /scrollIntoView/);
  assert.match(source, /message\.tool && <span className="ai-message-tool">/);
  assert.match(source, /message\.scenes && message\.scenes\.length > 0/);
  assert.match(source, /scene\.actionCount\} 个动作/);
  assert.doesNotMatch(source, /setDevices|onRun|fetch\(/, "the message list must never execute scenes or mutate device state");
});

test("composer caps input, counts characters, and never asks for a model key", async () => {
  const source = await read("../app/components/ai-assistant/ai-composer.tsx");
  assert.match(source, /maxLength=\{MAX_MESSAGE_LENGTH\}/);
  assert.match(source, /500/);
  assert.match(source, /\{value\.length\}\/\{MAX_MESSAGE_LENGTH\}/);
  assert.match(source, /aria-label="AI 助手消息输入"/);
  assert.match(source, /isComposing/, "Enter must not send while a Chinese IME composition is active");
  assert.match(source, /disabled=\{!sending\}/, "stop must only be pressable while a turn is in flight");
  assert.doesNotMatch(source, /apiKey|api-key|API Key|modelKey|模型 Key|密钥|localStorage|sessionStorage/i, "the composer must not collect model keys or persist chat state");
});

test("assistant styles cover the mobile drawer, safe areas, and the overlay ladder", async () => {
  const styles = await read("../app/ai-assistant.css");
  assert.match(styles, /\.ai-assistant-button\{[^}]*position:fixed/);
  assert.match(styles, /\.ai-assistant-panel\{[^}]*z-index:42/);
  assert.match(styles, /@media \(max-width:760px\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /height:100dvh/, "the mobile drawer must fill the dynamic viewport");
});

test("assistant exposure settings use compact filterable rows and select only filtered permissions", async () => {
  const source = await read("../app/components/ai-assistant/assistant-exposure-settings.tsx");
  const styles = await read("../app/ai-assistant.css");
  assert.match(source, /<table className="assistant-exposure-table">/);
  assert.match(source, /value=\{roomFilter\}/, "room filtering must be available");
  assert.match(source, /value=\{kindFilter\}/, "reading and device types must be filterable");
  assert.match(source, /value=\{search\}/, "rows must support text search");
  assert.match(source, /全选当前筛选结果/);
  assert.match(source, /for \(const row of filteredRows\)/, "bulk selection must only visit visible filtered rows");
  assert.match(source, /current\.filter\(ref => !refs\.has\(ref\)\)/, "deselecting filtered rows must preserve selected devices outside the filter");
  assert.match(source, /data-label="房间"/, "small screens must retain the table's field labels");
  assert.match(styles, /@media\(max-width:600px\).*\.assistant-exposure-table tbody tr\{display:grid/s);
});

test("Next routes own the AI API URLs and call shared handlers directly", async () => {
  const chat = await read("../app/api/ai/chat/route.ts");
  const conversations = await read("../app/api/ai/conversations/route.ts");
  const deletion = await read("../app/api/ai/conversations/[conversationId]/route.ts");
  const quota = await read("../app/api/ai/quota/route.ts");

  assert.match(chat, /createChatHandler\(\)/);
  assert.match(chat, /env: process\.env/);
  assert.match(chat, /export async function POST/);

  assert.match(conversations, /createConversationHandler\(\)/);
  assert.match(conversations, /export async function POST/);

  assert.match(deletion, /createDeleteConversationHandler\(\)/);
  assert.match(deletion, /export async function DELETE/);

  assert.match(quota, /onRequest as quotaHandler/);
  assert.match(quota, /export async function GET/);

  for (const route of [chat, conversations, deletion, quota]) {
    assert.doesNotMatch(route, /edge-functions/);
    assert.doesNotMatch(route, /authenticateXiaomiSession|readJsonBody|webApiErrorResponse/, "routes must reuse the shared boundary, not re-implement it");
  }
  const allApiRoutes = await Promise.all([
    "../app/api/ai/exposure/route.ts",
    "../app/api/internal/assistant/v1/capabilities/route.ts",
    "../app/api/internal/assistant/v1/tools:invoke/route.ts",
  ].map(read));
  assert.ok(allApiRoutes.every(route => !route.includes("edge-functions")));
});
