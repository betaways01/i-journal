/** Per-user FIFO for Telegram human turns. Held updates are never dropped. */

type Job = () => Promise<void>;

interface Queued {
  job: Job;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface UserQueue {
  busy: boolean;
  /** In-flight human turn; outbound pokes wait on this only. */
  current?: Promise<void>;
  jobs: Queued[];
}

const users = new Map<string, UserQueue>();

function queueOf(userId: string): UserQueue {
  let q = users.get(userId);
  if (!q) {
    q = { busy: false, jobs: [] };
    users.set(userId, q);
  }
  return q;
}

export function isUserTurnRunning(userId: string | number): boolean {
  return Boolean(users.get(String(userId))?.busy);
}

export function heldTurnCount(userId: string | number): number {
  const q = users.get(String(userId));
  if (!q) return 0;
  return q.jobs.length + (q.busy ? 1 : 0);
}

/** Run job as this user's next human turn. If a turn is already running, wait in FIFO. Never drop held jobs. */
export function enqueueUserTurn(userId: string | number, job: Job): Promise<void> {
  const id = String(userId);
  const q = queueOf(id);
  return new Promise<void>((resolve, reject) => {
    q.jobs.push({ job, resolve, reject });
    void pump(id);
  });
}

/** Heartbeat/reminder outbound: wait for the in-flight human turn if any, then send. Not a human FIFO job. */
export async function afterCurrentTurn(userId: string | number, job: Job): Promise<void> {
  const q = users.get(String(userId));
  if (q?.current) {
    await q.current.catch(() => undefined);
  }
  await job();
}

async function pump(userId: string): Promise<void> {
  const q = users.get(userId);
  if (!q || q.busy) return;
  const next = q.jobs.shift();
  if (!next) {
    users.delete(userId);
    return;
  }
  q.busy = true;
  let settle: () => void = () => undefined;
  q.current = new Promise<void>((resolve) => {
    settle = resolve;
  });
  try {
    await next.job();
    next.resolve();
  } catch (err) {
    console.error('[queue] turn failed for', userId, err);
    next.reject(err);
  } finally {
    q.busy = false;
    const done = q.current;
    q.current = undefined;
    settle();
    await done;
    void pump(userId);
  }
}
