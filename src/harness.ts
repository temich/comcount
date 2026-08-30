import { Redis } from 'ioredis'
import { counter, type CounterOptions, type Increment } from './counter.ts'
import { redisStore, type Store } from './store.ts'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

/** Interval the suites run at. Slower machines want more; the library has no floor. */
export const INTERVAL = Number(process.env.TEST_INTERVAL ?? 300)

export const connect = () => new Redis(REDIS_URL)

let seq = 0

/** A counter name no other test shares, so suites can run against one Redis. */
export const group = () => `comcount-test-${process.pid}-${++seq}`

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Polls `check` until it stops throwing, or gives up and rethrows. */
export const settle = async (check: () => unknown, timeout = 5000, step = 25) => {
  const deadline = Date.now() + timeout

  for (;;)
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error

      await sleep(step)
    }
}

export interface Fault {
  store: Store
  /** Fails the next `times` flushes, or every one until {@link Fault.heal}. */
  fail: (times?: number) => void
  /** Flushes rejected so far. */
  failures: () => number
  /**
   * Every subsequent flush hangs until {@link Fault.heal} — the case a client
   * with no command timeout leaves a participant in. How many have been
   * swallowed so far is on {@link Fault.hanging}.
   */
  stall: () => void
  /** Flushes left hanging and not yet settled. */
  hanging: () => number
  /** Restores the store, settling anything {@link Fault.stall} held open. */
  heal: () => void
}

/** Wraps a real store so a test can cut it off and restore it. */
export const faulty = (inner: Store): Fault => {
  let mode: 'well' | 'broken' | 'stalled' = 'well'
  let left = Infinity
  let failures = 0
  let held: ((reason: Error) => void)[] = []

  const hang = () =>
    new Promise<never>((_resolve, reject) => {
      held.push(reject)
    })

  return {
    store: {
      add: amount => {
        if (mode === 'broken' && left > 0) {
          left -= 1
          failures += 1

          return Promise.reject(new Error('injected outage'))
        }

        if (mode === 'stalled') return hang()

        return inner.add(amount)
      },
    },
    fail: (times = Infinity) => {
      mode = 'broken'
      left = times
    },
    failures: () => failures,
    stall: () => {
      mode = 'stalled'
    },
    hanging: () => held.length,
    heal: () => {
      mode = 'well'
      left = Infinity

      // A real client rejects its in-flight commands when the connection goes;
      // leaving them pending would hang the participant's shutdown, and the test.
      const pending = held
      held = []

      for (const reject of pending) reject(new Error('injected outage'))
    },
  }
}

/** One flush as it was sent, and the interval the server put it in. */
export interface Flush {
  amount: number
  interval: number
}

/** Wraps a store so a test can see what every flush carried and where it landed. */
export const recording = (inner: Store, into: Flush[]): Store => ({
  add: async amount => {
    const tally = await inner.add(amount)

    into.push({ amount, interval: tally.interval })

    return tally
  },
})

export interface Worker {
  increment: Increment
  close: () => Promise<void>
}

export interface StartOptions {
  /** Wraps the Redis-backed store, for fault injection or recording. */
  wrap?: (store: Store) => Store
}

/** Runs a counter on its own connection, the way a real participant would. */
export const start = (
  options: Omit<CounterOptions, 'redis' | 'store'>,
  { wrap }: StartOptions = {}
): Worker => {
  const redis = connect()

  const inner = redisStore(redis, {
    name: options.name,
    interval: options.interval,
    prefix: options.prefix,
  })

  const increment = counter({ ...options, store: wrap ? wrap(inner) : inner })

  let closing: Promise<void> | null = null

  return {
    increment,
    close() {
      // Tests close a participant to model it leaving, and again on teardown.
      closing ??= (async () => {
        increment.close()
        await redis.quit()
      })()

      return closing
    },
  }
}

/** Every interval key of a counter, oldest first. */
export const totals = async (name: string, prefix = '') => {
  const redis = connect()

  try {
    const keys = await redis.keys(`${prefix}{${name}}:*`)
    const values = keys.length > 0 ? await redis.mget(keys) : []

    return (
      keys
        .map((key, index) => ({ interval: Number(key.split(':').pop()), value: values[index] }))
        // A key can reach its ttl between the listing and the read; that is the
        // key being gone, not an interval that came to nothing.
        .filter((entry): entry is { interval: number; value: string } => entry.value !== null)
        .map(({ interval, value }) => ({ interval, total: Number(value) }))
        .toSorted((a, b) => a.interval - b.interval)
    )
  } finally {
    await redis.quit()
  }
}

export const sum = (of: { total: number }[]) => of.reduce((all, one) => all + one.total, 0)
