import { createHash } from 'node:crypto'
import { sink, type Console } from './console.ts'
import { ADD } from './lua.ts'

/** What one flush came to: where the amount landed, and what closed before it. */
export interface Tally {
  /** The interval the amount was added to, from the server clock. */
  interval: number
  /**
   * The total across every participant in the interval before it, or `null`
   * when that interval has no key — nothing was ever added to it.
   */
  previous: number | null
}

/**
 * The one operation the counter needs: add this to whichever interval the
 * server is in, and say what the one before it came to. Implemented over Redis
 * below; anything else that can honour the contract may be passed in its place.
 */
export interface Store {
  add(amount: number): Promise<Tally>
}

/** How ioredis takes a script: the key count, then keys, then arguments. */
interface Ioredis {
  eval(script: string, keys: number, ...args: string[]): Promise<unknown>
  evalsha(sha: string, keys: number, ...args: string[]): Promise<unknown>
}

/** How node-redis takes a script: keys and arguments as named lists. */
interface NodeRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
  evalSha(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Either client will do; the two call shapes are normalised below. */
export type RedisLike = Ioredis | NodeRedis

export interface RedisStoreOptions {
  /** Counter name, for example `requests`. */
  name: string
  /** Interval length in milliseconds. */
  interval: number
  /** Prepended to the key, for namespacing. */
  prefix?: string
  /** Where to report what the store is doing. */
  console?: Console
}

/**
 * Keys are written as `{name}:N`. The braces are a Redis hash tag, so every
 * interval key of a counter lands in one slot and the two keys the script
 * touches are never cross-slot.
 */
export const base = ({ name, prefix = '' }: RedisStoreOptions): string => `${prefix}{${name}}`

/**
 * Intervals an interval key is kept for. It only has to outlive the one
 * interval that reads it; the rest is room for a participant that fell behind.
 */
const KEEP = 3

const SHA = createHash('sha1').update(ADD).digest('hex')

const isNodeRedis = (redis: RedisLike): redis is NodeRedis => 'evalSha' in redis

/** Redis reports an unknown script by name; anything else is a real failure. */
const isMissingScript = (error: unknown) =>
  error instanceof Error && error.message.includes('NOSCRIPT')

export const redisStore = (redis: RedisLike, options: RedisStoreOptions): Store => {
  const key = base(options)
  const ttl = String(options.interval * KEEP)
  const log = sink(options.console, { name: options.name })

  const byHash = (argv: string[]) =>
    isNodeRedis(redis)
      ? redis.evalSha(SHA, { keys: [key], arguments: argv })
      : redis.evalsha(SHA, 1, key, ...argv)

  const bySource = (argv: string[]) =>
    isNodeRedis(redis)
      ? redis.eval(ADD, { keys: [key], arguments: argv })
      : redis.eval(ADD, 1, key, ...argv)

  /** Send the hash, and only ship the source when the server has not seen it. */
  const call = async (argv: string[]) => {
    try {
      return await byHash(argv)
    } catch (error) {
      if (!isMissingScript(error)) throw error

      // Once per server, not once per participant: the source it is about to
      // ship stays cached for everyone.
      log.debug('script loaded', { sha: SHA })

      return await bySource(argv)
    }
  }

  return {
    async add(amount) {
      const reply = await call([String(options.interval), ttl, String(amount)])

      if (!Array.isArray(reply) || reply.length !== 3)
        throw new TypeError(`comcount: unexpected reply ${JSON.stringify(reply)}`)

      const [interval, present, previous] = reply.map(Number)

      return { interval: interval!, previous: present === 1 ? previous! : null }
    },
  }
}
