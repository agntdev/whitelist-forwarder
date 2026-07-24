import { Composer } from "grammy";
import type { Message } from "grammy/types";
import type { Ctx } from "../bot.js";
import { now } from "../clock.js";
import {
  addWhitelistEntry,
  clearWhitelist,
  getConfig,
  recordDelivery,
  recordFailure,
  routesFor,
  setDestination,
  type ForwarderConfig,
  type WhitelistType,
} from "../forwarder-store.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";

registerMainMenuItem({ label: "Configure forwarding", data: "fw:open", order: 10 });
registerMainMenuItem({ label: "Forwarding status", data: "fw:status", order: 11 });

type FlowStep = "destination" | "user" | "group";
type ForwarderSession = { forwarderStep?: FlowStep };
const composer = new Composer<Ctx>();

const dashboardKeyboard = inlineKeyboard([
  [inlineButton("Set target channel", "fw:destination")],
  [inlineButton("Add approved user", "fw:add-user"), inlineButton("Add approved group", "fw:add-group")],
  [inlineButton("View approved sources", "fw:list")],
  [inlineButton("Clear approved sources", "fw:clear")],
  [inlineButton("Back to menu", "menu:main")],
]);
const backKeyboard = inlineKeyboard([[inlineButton("Back to forwarding", "fw:open")]]);

function actorId(ctx: Ctx): number | undefined {
  return ctx.from?.id;
}

function session(ctx: Ctx): ForwarderSession {
  return ctx.session as ForwarderSession;
}

function dashboardText(config: ForwarderConfig): string {
  const channel = config.destinationChannelId ? "A target channel is set." : "No target channel is set yet.";
  const total = config.whitelist.length;
  return `${channel}\n${total === 0 ? "No approved sources yet." : `${total} approved ${total === 1 ? "source" : "sources"}.`}\n\nChoose what to update.`;
}

async function showDashboard(ctx: Ctx, edit: boolean): Promise<void> {
  const ownerId = actorId(ctx);
  if (!ownerId) return;
  try {
    const text = dashboardText(await getConfig(ctx, ownerId));
    if (edit) await ctx.editMessageText(text, { reply_markup: dashboardKeyboard });
    else await ctx.reply(text, { reply_markup: dashboardKeyboard });
  } catch {
    await ctx.reply("Forwarding storage isn't set up yet. Add persistent storage, then try again.");
  }
}

composer.callbackQuery("fw:open", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDashboard(ctx, true);
});

composer.callbackQuery("fw:status", async (ctx) => {
  await ctx.answerCallbackQuery();
  const ownerId = actorId(ctx);
  if (!ownerId) return;
  try {
    const config = await getConfig(ctx, ownerId);
    const failures = config.failures.length;
    const text = config.destinationChannelId
      ? `Forwarding is ready for ${config.whitelist.length} approved ${config.whitelist.length === 1 ? "source" : "sources"}.`
      : "Forwarding needs a target channel before it can send messages.";
    await ctx.editMessageText(failures ? `${text}\n${failures} recent delivery ${failures === 1 ? "issue" : "issues"} logged.` : text, { reply_markup: backKeyboard });
  } catch {
    await ctx.editMessageText("Forwarding storage isn't set up yet. Add persistent storage, then try again.", { reply_markup: backKeyboard });
  }
});

composer.callbackQuery("fw:destination", async (ctx) => {
  await ctx.answerCallbackQuery();
  session(ctx).forwarderStep = "destination";
  await ctx.editMessageText("Send the target channel ID. It usually starts with -100.", {
    reply_markup: inlineKeyboard([[inlineButton("Cancel", "fw:cancel")]]),
  });
});

function beginAdd(type: WhitelistType) {
  return async (ctx: Ctx) => {
    await ctx.answerCallbackQuery();
    session(ctx).forwarderStep = type;
    await ctx.editMessageText(`Send the ${type} Telegram ID to approve.`, {
      reply_markup: inlineKeyboard([[inlineButton("Cancel", "fw:cancel")]]),
    });
  };
}
composer.callbackQuery("fw:add-user", beginAdd("user"));
composer.callbackQuery("fw:add-group", beginAdd("group"));

composer.callbackQuery("fw:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  delete session(ctx).forwarderStep;
  await showDashboard(ctx, true);
});

composer.callbackQuery("fw:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const ownerId = actorId(ctx);
  if (!ownerId) return;
  try {
    const config = await getConfig(ctx, ownerId);
    const users = config.whitelist.filter((item) => item.type === "user").length;
    const groups = config.whitelist.length - users;
    const text = config.whitelist.length === 0
      ? "No approved sources yet — add a user or group to begin forwarding."
      : `${users} approved ${users === 1 ? "user" : "users"} and ${groups} approved ${groups === 1 ? "group" : "groups"}.`;
    await ctx.editMessageText(text, { reply_markup: backKeyboard });
  } catch {
    await ctx.editMessageText("Forwarding storage isn't set up yet. Add persistent storage, then try again.", { reply_markup: backKeyboard });
  }
});

composer.callbackQuery("fw:clear", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Remove every approved source? Messages will stop forwarding until you add them again.", {
    reply_markup: inlineKeyboard([[inlineButton("Remove all", "fw:clear:yes"), inlineButton("Keep sources", "fw:open")]]),
  });
});

composer.callbackQuery("fw:clear:yes", async (ctx) => {
  await ctx.answerCallbackQuery();
  const ownerId = actorId(ctx);
  if (!ownerId) return;
  try {
    await clearWhitelist(ctx, ownerId);
    await ctx.editMessageText("All approved sources were removed.", { reply_markup: backKeyboard });
  } catch {
    await ctx.editMessageText("Couldn't update the approved sources. Try again after storage is available.", { reply_markup: backKeyboard });
  }
});

async function saveTypedValue(ctx: Ctx, value: string): Promise<boolean> {
  const step = session(ctx).forwarderStep;
  const ownerId = actorId(ctx);
  if (!step || !ownerId) return false;
  const id = Number(value.trim());
  if (!Number.isSafeInteger(id) || id === 0) {
    await ctx.reply("That doesn't look like a valid Telegram ID. Send the number again.");
    return true;
  }
  try {
    if (step === "destination") {
      await setDestination(ctx, ownerId, id);
      delete session(ctx).forwarderStep;
      await ctx.reply("Your target channel is set.", { reply_markup: backKeyboard });
      return true;
    }
    const added = await addWhitelistEntry(ctx, ownerId, { telegram_id: id, type: step });
    delete session(ctx).forwarderStep;
    await ctx.reply(added ? `That ${step} is approved for forwarding.` : `That ${step} is already approved.`, { reply_markup: backKeyboard });
    return true;
  } catch {
    await ctx.reply("Couldn't save that setting. Check that persistent storage is available and try again.");
    return true;
  }
}

function canForward(message: Message): boolean {
  return !("has_protected_content" in message && message.has_protected_content) &&
    !("migrate_to_chat_id" in message) &&
    !("migrate_from_chat_id" in message);
}

function attribution(ctx: Ctx): string {
  if (ctx.chat?.type !== "private") return ctx.chat?.title ?? "an approved group";
  return ctx.from?.first_name ?? "an approved sender";
}

async function deliver(ctx: Ctx, config: ForwarderConfig): Promise<boolean> {
  const message = ctx.message;
  if (!message || !config.destinationChannelId || !canForward(message)) return false;
  let lastError = "Telegram did not accept the message.";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ctx.api.forwardMessage(config.destinationChannelId, message.chat.id, message.message_id);
      try {
        await recordDelivery(ctx, config.ownerId, now().toISOString());
      } catch {
        // Delivery succeeded; an unavailable status log must not resend it.
      }
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
  }
  try {
    await ctx.api.sendMessage(config.destinationChannelId, `Forwarded from ${attribution(ctx)}:`);
    await ctx.api.copyMessage(config.destinationChannelId, message.chat.id, message.message_id);
    try {
      await recordDelivery(ctx, config.ownerId, now().toISOString());
    } catch {
      // Delivery succeeded; an unavailable status log must not resend it.
    }
    return true;
  } catch (error) {
    lastError = error instanceof Error ? error.message : lastError;
  }
  await recordFailure(ctx, config.ownerId, {
    at: now().toISOString(),
    sourceChatId: message.chat.id,
    messageId: message.message_id,
    detail: lastError.slice(0, 240),
  });
  try {
    await ctx.api.sendMessage(config.ownerChatId, "A message couldn't be forwarded after automatic retries. Check the target channel permissions.");
  } catch {
    // The owner may have blocked the bot; delivery attempts for other routes continue.
  }
  return false;
}

composer.on("message", async (ctx, next) => {
  const text = ctx.message?.text;
  if (text?.startsWith("/")) return next();
  if (text && await saveTypedValue(ctx, text)) return;
  const sourceIds = [ctx.chat?.id, ctx.from?.id].filter((id): id is number => typeof id === "number");
  if (sourceIds.length === 0 || !ctx.message || !canForward(ctx.message)) return;
  try {
    const routes = await routesFor(ctx, sourceIds);
    if (routes.length === 0) return next();
    for (const route of routes) await deliver(ctx, route);
  } catch {
    // An unavailable store must never forward an unverified message.
    return next();
  }
});

export default composer;
