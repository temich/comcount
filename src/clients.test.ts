import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Redis } from 'ioredis'
import { createClient } from 'redis'
import { group, INTERVAL, REDIS_URL, settle, sum, totals } from './harness.ts'
import { counter } from './counter.ts'
import type { RedisLike } from './store.ts'

interface Client {
  redis: RedisLike
  close: () => Promise<void>
}

/** The two clients that cover almost all of Node, with their differing call shapes. */
const clients: { name: string; open: () => Promise<Client> }[] = [
  {
    name: 'ioredis',
    open: async () => {
      const redis = new Redis(REDIS_URL)

      return {
        redis,
        close: async () => {
          await redis.quit()
        },
      }
    },
  },
  {
    name: 'node-redis',
    open: async () => {
      const redis = createClient({ url: REDIS_URL })
      await redis.connect()

      return {
        redis,
        close: async () => {
          await redis.close()
        },
      }
    },
  },
]

describe('clients', () => {
  for (const { name: client, open } of clients)
    it(`counts a group over ${client}`, async () => {
      const name = group()
      const amounts = [1, 2, 4]
      const opened = await Promise.all(amounts.map(() => open()))

      const counters = opened.map(({ redis }) => counter({ redis, name, interval: INTERVAL }))

      try {
        counters.forEach((increment, index) => increment(amounts[index]!))

        await settle(async () => assert.equal(sum(await totals(name)), 7), INTERVAL * 6)
      } finally {
        for (const increment of counters) increment.close()

        await Promise.all(opened.map(({ close }) => close()))
      }
    })
})
