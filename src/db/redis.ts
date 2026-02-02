import Redis from "ioredis";

let _redis: Redis | null = null;
let _subscriber: Redis | null = null;
const channelHandlers = new Map<string, Set<(data: unknown) => void>>();
let subscriberReady = false;

function createRedisInstance(): Redis {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const instance = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    lazyConnect: false,
  });

  instance.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });

  return instance;
}

/**
 * Returns the singleton Redis client instance.
 * Connection URL is read from REDIS_URL env var, defaulting to redis://localhost:6379.
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = createRedisInstance();
  }
  return _redis;
}

/**
 * Singleton Redis instance for general use (commands, get/set, etc.).
 */
export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const instance = getRedis();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});

/**
 * Returns true if the Redis server is reachable, false otherwise.
 */
export async function redisHealthCheck(): Promise<boolean> {
  try {
    const client = getRedis();
    const pong = await client.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

/**
 * Publishes a JSON-serialized message to a Redis channel.
 */
export function publish(channel: string, data: unknown): Promise<number> {
  const client = getRedis();
  return client.publish(channel, JSON.stringify(data));
}

/**
 * Subscribes to a Redis channel using a dedicated subscriber connection.
 * The callback receives the parsed JSON data for each message.
 * Returns an unsubscribe function to clean up when done.
 */
export async function subscribe(
  channel: string,
  callback: (data: unknown) => void
): Promise<() => void> {
  if (!_subscriber) {
    _subscriber = createRedisInstance();
  }
  if (!subscriberReady) {
    _subscriber.on("message", (msgChannel: string, message: string) => {
      const handlers = channelHandlers.get(msgChannel);
      if (!handlers || handlers.size === 0) return;
      let payload: unknown = message;
      try {
        payload = JSON.parse(message);
      } catch {
        // keep raw message
      }
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch {
          // Ignore individual handler errors
        }
      }
    });
    subscriberReady = true;
  }

  let handlers = channelHandlers.get(channel);
  if (!handlers) {
    handlers = new Set();
    channelHandlers.set(channel, handlers);
    try {
      await _subscriber.subscribe(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to subscribe to channel "${channel}":`, message);
    }
  }

  handlers.add(callback);

  // Return an unsubscribe function
  return () => {
    const existing = channelHandlers.get(channel);
    if (!existing) return;
    existing.delete(callback);
    if (existing.size === 0) {
      channelHandlers.delete(channel);
      _subscriber?.unsubscribe(channel).catch(() => {});
    }
  };
}
