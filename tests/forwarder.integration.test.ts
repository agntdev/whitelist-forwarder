import { Composer } from "grammy";
import { describe, expect, it } from "vitest";
import { buildBot, type Ctx } from "../src/bot.js";
import { addWhitelistEntry, setDestination } from "../src/forwarder-store.js";
import forwarder from "../src/handlers/forwarder.js";
import { MemorySessionStorage } from "../src/toolkit/index.js";

function domainEnvironment() {
  const records: Record<string, unknown> = {};
  return {
    BOT_TOKEN: "test-token",
    CHAT_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string, init?: { method?: string; body?: string }) => {
          const url = new URL(input);
          if (url.pathname !== "/domain") return new Response("not found", { status: 404 });
          if (init?.method === "PUT") {
            const body = JSON.parse(init.body ?? "{}") as { key: string; value: unknown };
            records[`domain:${body.key}`] = body.value;
            return new Response(null, { status: 204 });
          }
          const key = url.searchParams.get("key");
          const value = key ? records[`domain:${key}`] : undefined;
          return value === undefined ? new Response(null, { status: 204 }) : Response.json(value);
        },
      }),
    },
  };
}

function incoming(updateId: number, content: Record<string, unknown>, senderId = 9) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: senderId, type: "private", first_name: "Source" },
      from: { id: senderId, is_bot: false, first_name: "Source" },
      ...content,
    },
  } as any;
}

describe("whitelist forwarding", () => {
  it("forwards fifteen Telegram message types and never forwards an unapproved sender", async () => {
    const env = domainEnvironment();
    const setup = { chat: { id: 1 }, session: {}, env } as unknown as Ctx;
    await setDestination(setup, 1, -100123);
    await addWhitelistEntry(setup, 1, { telegram_id: 9, type: "user" });

    const attachEnv = new Composer<Ctx>();
    attachEnv.use((ctx, next) => {
      (ctx as Ctx & { env?: typeof env }).env = env;
      return next();
    });
    const bot = await buildBot("test-token", {
      handlers: [attachEnv, forwarder],
      storage: new MemorySessionStorage(),
    });
    bot.botInfo = { id: 42, is_bot: true, first_name: "TestBot", username: "test_bot" } as any;
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: (payload ?? {}) as Record<string, unknown> });
      return { ok: true, result: true } as any;
    });

    const types = [
      { text: "text" },
      { photo: [{ file_id: "photo", file_unique_id: "p", width: 1, height: 1 }] },
      { video: { file_id: "video", file_unique_id: "v", width: 1, height: 1, duration: 1 } },
      { audio: { file_id: "audio", file_unique_id: "a", duration: 1 } },
      { document: { file_id: "document", file_unique_id: "d" } },
      { voice: { file_id: "voice", file_unique_id: "vo", duration: 1 } },
      { animation: { file_id: "animation", file_unique_id: "an", width: 1, height: 1, duration: 1 } },
      { sticker: { file_id: "sticker", file_unique_id: "s", width: 1, height: 1, is_animated: false, is_video: false, type: "regular" } },
      { video_note: { file_id: "note", file_unique_id: "n", length: 1, duration: 1 } },
      { contact: { phone_number: "1", first_name: "Contact" } },
      { location: { latitude: 1, longitude: 1 } },
      { venue: { location: { latitude: 1, longitude: 1 }, title: "Venue", address: "Address" } },
      { poll: { id: "poll", question: "Question", options: [], total_voter_count: 0, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false } },
      { dice: { emoji: "🎲", value: 1 } },
      { game: { title: "Game", description: "Game", photo: [] } },
    ];
    for (const [index, content] of types.entries()) await bot.handleUpdate(incoming(index + 1, content));
    await bot.handleUpdate(incoming(100, { text: "not approved" }, 88));

    expect(calls.filter((call) => call.method === "forwardMessage")).toHaveLength(15);
    expect(calls.filter((call) => call.method === "forwardMessage").every((call) => call.payload.chat_id === -100123)).toBe(true);
    expect(calls.filter((call) => call.method === "forwardMessage").every((call) => call.payload.from_chat_id === 9)).toBe(true);
  });
});
