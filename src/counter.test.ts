import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  connect,
  group,
  INTERVAL,
  settle,
  sleep,
  start,
  sum,
  totals,
  type Worker,
} from './harness.ts'

describe('counter', () => {
  const running: Worker[] = []

  const spawn = (name: string) => {
    const worker = start({ name, interval: INTERVAL })
    running.push(worker)

    return worker
  }

  after(async () => {
    await Promise.all(running.map(worker => worker.close()))
  })

  it('adds a lone participant to one interval', async () => {
    const name = group()

    spawn(name).increment(5)

    await settle(async () => assert.equal(sum(await totals(name)), 5), INTERVAL * 3)
  })

  it('counts one when no amount is given', async () => {
    const name = group()

    spawn(name).increment()

    await settle(async () => assert.equal(sum(await totals(name)), 1), INTERVAL * 3)
  })

  it('sums every participant of the same name', async () => {
    const name = group()
    const amounts = [1, 2, 4]

    for (const amount of amounts) spawn(name).increment(amount)

    await settle(async () => assert.equal(sum(await totals(name)), 7), INTERVAL * 4)
  })

  it('keeps counters of different names apart', async () => {
    const [one, other] = [group(), group()]

    spawn(one).increment(5)
    spawn(other).increment(9)

    await settle(async () => assert.equal(sum(await totals(one)), 5), INTERVAL * 3)
    assert.equal(sum(await totals(other)), 9)
  })

  it('namespaces by prefix', async () => {
    const name = group()
    const worker = start({ name, interval: INTERVAL, prefix: 'app:' })
    running.push(worker)

    worker.increment(3)

    await settle(async () => assert.equal(sum(await totals(name, 'app:')), 3), INTERVAL * 3)
    assert.deepEqual(await totals(name), [])
  })

  it('expires interval keys', async () => {
    const name = group()
    const redis = connect()

    spawn(name).increment(1)

    try {
      await settle(
        async () => assert.ok((await redis.keys(`{${name}}:*`)).length > 0),
        INTERVAL * 3
      )

      const [key] = await redis.keys(`{${name}}:*`)
      const ttl = await redis.pttl(key!)

      // Kept for three intervals; it is counting down from there.
      assert.ok(ttl > 0 && ttl <= INTERVAL * 3, `unexpected ttl ${ttl}`)

      // Nothing older than the ttl survives, however long the counter runs.
      await sleep(INTERVAL * 5)
      assert.ok((await redis.keys(`{${name}}:*`)).length <= 4)
    } finally {
      await redis.quit()
    }
  })
})
