import { Queue } from "bullmq";

const QUEUE_NAME = "reviews";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * The BullMQ queue instance. Import this to add review jobs or
 * inspect queue state (e.g. getWaitingCount).
 */
export const reviewQueue = new Queue(QUEUE_NAME, {
  connection: { url: REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 604800 },
  },
});

export { QUEUE_NAME, REDIS_URL };
