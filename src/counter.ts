import { sink, type Console } from './console.ts'
import { redisStore, type RedisLike, type Store } from './store.ts'

export interface CounterOptions {
  /** An ioredis or node-redis client. Mutually exclusive with `store`. */
  redis?: RedisLike
  /** A store of your own, in place of `redis`. */
  store?: Store
  /** Counter name, for example `requests`. */
  name: string
  /** Interval length in milliseconds. See the README on choosing one. */
  interval: number
  /** Prepended to the key, for namespacing. */
  prefix?: string
  /**
   * Where to report what the counter is doing — anything with `trace`,
   * `debug`, `info`, `warn` and `error`, the global `console` included. A
   * healthy counter never rises above `info`.
   */
  console?: Console
}

export interface Total {
  /**
   * A lower bound on what the whole group is counting: the total every
   * participant reached over the last closed interval, or this participant's
   * own unsent buffer where that is larger — or is all there is.
   */
  count: number
}

export interface Increment {
  (amount?: number): Total
  /** Stops the counter. Sends nothing, waits for nothing, and is idempotent. */
  close(): void
}

/**
 * Intervals a total stays usable for. A flush that never returns leaves the
 * last one that did standing, and a total nothing is refreshing is worse than
 * none: it reads low, and low is the direction that fails to act on.
 */
const STALE = 2

const storeFor = (options: CounterOptions): Store => {
  if (options.store) return options.store
  if (!options.redis) throw new TypeError('comcount: counter needs either `redis` or `store`')

  return redisStore(options.redis, {
    name: options.name,
    interval: options.interval,
    prefix: options.prefix,
    console: options.console,
  })
}

/**
 * Counts alongside every other participant of the same name, and hands back
 * what the group came to.
 *
 * The returned function is synchronous: it adds to a local buffer and reports
 * the group's number from what is already known. Sending happens on its own,
 * once an interval, and nothing the caller does waits on it.
 *
 * A participant adds to a given interval **at most once**, so the group's total
 * is never overstated. It can be understated: a flush whose reply is lost takes
 * its buffer with it, and one that arrives late leaves its interval empty.
 */
export const counter = (options: CounterOptions): Increment => {
  const { interval } = options
  const log = sink(options.console, { name: options.name })

  if (!(Number.isFinite(interval) && interval > 0))
    throw new RangeError(`comcount: \`interval\` must be a positive number, got ${interval}`)

  const store = storeFor(options)

  let pending = 0
  let total: number | null = null
  let started = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined

  /**
   * Both numbers are lower bounds on the same thing, measured differently: the
   * total covers the whole group but a closed interval, the buffer covers the
   * open interval but one participant. Whichever is larger is the safer answer,
   * and a participant that has on its own already outrun the group's last
   * interval is exactly the case a smaller number would fail to act on.
   */
  const count = () => (total === null ? pending : Math.max(total, pending))

  /** A total nothing has refreshed for long enough stops counting as known. */
  const arm = () => {
    clearTimeout(expiry)

    expiry = setTimeout(() => {
      log.warn('total went stale', { after: STALE * interval })

      total = null
    }, STALE * interval)

    expiry.unref()
  }

  const flush = async () => {
    // Emptied at the point of sending, not when the reply lands. A reply that
    // never comes leaves the amount neither counted nor countable: whether it
    // reached the server is exactly what is unknown, so keeping it for the next
    // interval is how a total ends up overstated. Dropping it is the trade.
    const amount = pending
    pending = 0

    try {
      const tally = await store.add(amount)

      total = tally.previous
      clearTimeout(expiry)

      if (total !== null) arm()

      log.debug('flush completed', { interval: tally.interval, amount, count: total })
    } catch (error) {
      log.error('flush failed', { error, dropped: amount })
    }
  }

  /**
   * One flush at a time, and the next interval counted from the reply rather
   * than from the send. That ordering is the whole guarantee: the next flush
   * reaches the server no sooner than an interval after the last one ran there,
   * so it cannot land in the interval that one already landed in — whatever the
   * two clocks disagree about.
   *
   * The cost is that the flush drifts a round trip further into the interval
   * every time, and now and then steps over the edge, leaving one interval
   * without a contribution. That is an undercount, which is the side this
   * library is allowed to be wrong on.
   */
  const tick = async () => {
    if (stopped) return

    await flush()

    if (stopped) return

    timer = setTimeout(run, interval)
    timer.unref()
  }

  const run = () => {
    tick().catch(() => {
      // Flush failures are handled inside; this guards the tick itself.
    })
  }

  const close = () => {
    if (stopped) return

    stopped = true
    clearTimeout(timer)
    clearTimeout(expiry)

    // Nothing is refreshing the total any more, so nothing about it is fresh.
    // What is left to report is the buffer, which is at least honest about
    // being one participant's own. There is no parting flush: it would arrive
    // sooner than an interval after the last one, which is the one thing that
    // could count this participant into the same interval twice.
    total = null

    log.info('counter stopped', {})
  }

  const increment = (amount = 1): Total => {
    if (!Number.isSafeInteger(amount))
      throw new TypeError(`comcount: \`amount\` must be a safe integer, got ${amount}`)

    pending += amount

    // The tick starts with the first contribution rather than with the counter,
    // so one that is never incremented never touches the server. It is armed
    // through a timer, never inline, which keeps this call free of anything the
    // flush does to the buffer.
    if (!started && !stopped) {
      started = true

      log.info('counter started', {
        interval,
        prefix: options.prefix ?? '',
        store: options.store ? 'custom' : 'redis',
      })

      timer = setTimeout(run, 0)
      timer.unref()
    }

    return { count: count() }
  }

  return Object.assign(increment, { close })
}
