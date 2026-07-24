import type { Ctx } from "./bot.js";
import type { WorkerEnv } from "./toolkit/session/durable.js";

export type WhitelistType = "user" | "group";

export interface WhitelistEntry {
  telegram_id: number;
  type: WhitelistType;
}

export interface DeliveryFailure {
  at: string;
  sourceChatId: number;
  messageId: number;
  detail: string;
}

export interface ForwarderConfig {
  ownerId: number;
  ownerChatId: number;
  destinationChannelId?: number;
  whitelist: WhitelistEntry[];
  failures: DeliveryFailure[];
  lastDeliveryAt?: string;
}

type WorkerContext = Ctx & { env?: WorkerEnv };

interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

class DurableObjectStore implements KeyValueStore {
  constructor(private readonly env: WorkerEnv) {}

  private async request(path: string, init?: { method?: string; body?: string }): Promise<Response> {
    const stub = this.env.CHAT_DO.get(this.env.CHAT_DO.idFromName("forwarder:domain"));
    return stub.fetch(`https://do${path}`, init);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const response = await this.request(`/domain?key=${encodeURIComponent(key)}`);
    if (response.status === 204) return undefined;
    if (!response.ok) throw new Error("The forwarding settings could not be read.");
    return (await response.json()) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    const response = await this.request("/domain", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
    if (!response.ok) throw new Error("The forwarding settings could not be saved.");
  }
}

class RedisStore implements KeyValueStore {
  private static client: Promise<{ get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> }> | undefined;

  private static async connect() {
    if (!RedisStore.client) {
      const url = typeof process === "undefined" ? undefined : process.env.REDIS_URL;
      if (!url) throw new Error("Persistent storage is not configured.");
      RedisStore.client = (async () => {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        // ioredis is loaded only in the Node runtime; Workers use Durable Objects above.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const module: any = require("ioredis");
        const Redis = module.default ?? module.Redis ?? module;
        return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
      })();
    }
    return RedisStore.client;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await (await RedisStore.connect()).get(`forwarder:${key}`);
    return value === null ? undefined : (JSON.parse(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    await (await RedisStore.connect()).set(`forwarder:${key}`, JSON.stringify(value));
  }
}

function storage(ctx: Ctx): KeyValueStore {
  const env = (ctx as WorkerContext).env;
  if (env?.CHAT_DO) return new DurableObjectStore(env);
  return new RedisStore();
}

const configKey = (ownerId: number) => `config:${ownerId}`;
const routeKey = (telegramId: number) => `route:${telegramId}`;

export async function getConfig(ctx: Ctx, ownerId: number): Promise<ForwarderConfig> {
  const store = storage(ctx);
  return (await store.get<ForwarderConfig>(configKey(ownerId))) ?? {
    ownerId,
    ownerChatId: ctx.chat?.id ?? ownerId,
    whitelist: [],
    failures: [],
  };
}

export async function saveConfig(ctx: Ctx, config: ForwarderConfig): Promise<void> {
  await storage(ctx).put(configKey(config.ownerId), config);
}

export async function setDestination(ctx: Ctx, ownerId: number, channelId: number): Promise<void> {
  const config = await getConfig(ctx, ownerId);
  config.destinationChannelId = channelId;
  await saveConfig(ctx, config);
}

export async function addWhitelistEntry(
  ctx: Ctx,
  ownerId: number,
  entry: WhitelistEntry,
): Promise<boolean> {
  const store = storage(ctx);
  const config = await getConfig(ctx, ownerId);
  if (config.whitelist.some((item) => item.telegram_id === entry.telegram_id && item.type === entry.type)) {
    return false;
  }
  config.whitelist.push(entry);
  await store.put(configKey(ownerId), config);

  const key = routeKey(entry.telegram_id);
  const owners = (await store.get<number[]>(key)) ?? [];
  if (!owners.includes(ownerId)) await store.put(key, [...owners, ownerId]);
  return true;
}

export async function clearWhitelist(ctx: Ctx, ownerId: number): Promise<void> {
  const store = storage(ctx);
  const config = await getConfig(ctx, ownerId);
  for (const entry of config.whitelist) {
    const key = routeKey(entry.telegram_id);
    const owners = (await store.get<number[]>(key)) ?? [];
    await store.put(key, owners.filter((id) => id !== ownerId));
  }
  config.whitelist = [];
  await store.put(configKey(ownerId), config);
}

export async function routesFor(ctx: Ctx, sourceIds: number[]): Promise<ForwarderConfig[]> {
  const store = storage(ctx);
  const ownerIds: number[] = [];
  for (const sourceId of sourceIds) {
    for (const ownerId of (await store.get<number[]>(routeKey(sourceId))) ?? []) {
      if (!ownerIds.includes(ownerId)) ownerIds.push(ownerId);
    }
  }
  const configs: ForwarderConfig[] = [];
  for (const ownerId of ownerIds) {
    const config = await store.get<ForwarderConfig>(configKey(ownerId));
    if (config?.destinationChannelId) configs.push(config);
  }
  return configs;
}

export async function recordFailure(ctx: Ctx, ownerId: number, failure: DeliveryFailure): Promise<void> {
  const config = await getConfig(ctx, ownerId);
  config.failures = [...config.failures, failure].slice(-50);
  await saveConfig(ctx, config);
}

/** Keep a lightweight delivery status without retaining message content. */
export async function recordDelivery(ctx: Ctx, ownerId: number, at: string): Promise<void> {
  const config = await getConfig(ctx, ownerId);
  config.lastDeliveryAt = at;
  await saveConfig(ctx, config);
}
