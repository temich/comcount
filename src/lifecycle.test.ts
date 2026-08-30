import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  connect,
  faulty,
  group,
  INTERVAL,
  recording,
  settle,
  sleep,
  start,
  sum,
  totals,
  type Fault,
  type Flush,
  type Worker,
} from './harness.ts'
import { redisStore } from './store.ts'

describe('lifecycle', () => {
  const running: Worker[] = []
  const connections: ReturnType<typeof connect>[] = []
  const faults: Fault[] = []

  /** A participant whose store a test can cut off, with its flushes recorded. */
  const injected = (name: string) => {
    const redis = connect()
    connections.push(redis)

    const outage = faulty(redisStore(redis, { name, interval: INTERVAL }))
    faults.push(outage)

    // Recording sits outside the fault, so only what actually reached Redis
    // is counted as a flush.
    const flushes: Flush[] = []
    const worker = start(
      { name, interval: INTERVAL },
      { wrap: () => recording(outage.store, flushes) }
    )

    running.push(worker)

    return { worker, outage, flushes }
  }

  after(async () => {
    // Closing does not await anything, but a stalled store left holding
    // promises would keep this process from settling.
    for (const outage of faults) outage.heal()

    await Promise.all(running.map(worker => worker.close()))
    await Promise.all(connections.map(redis => redis.quit()))
  })

  it('drops the buffer a failed flush was carrying', async () => {
    const name = group()
    const { worker, outage } = injected(name)

    outage.fail(1)
    worker.increment(5)

    // Wait for the flush to have taken the five with it. Five went out with a
    // call that never answered, so it is gone: counting it again later is
    // exactly how a total would end up overstated.
    await settle(() => assert.equal(outage.failures(), 1), INTERVAL * 4)

    worker.increment(7)

    await settle(async () => assert.equal(sum(await totals(name)), 7), INTERVAL * 5)

    await sleep(INTERVAL * 2)
    assert.equal(sum(await totals(name)), 7, 'the dropped five must never turn up')
    assert.equal(outage.failures(), 1)
  })

  it('keeps ticking after a failure', async () => {
    const name = group()
    const { worker, outage, flushes } = injected(name)

    outage.fail(1)
    worker.increment(1)

    await settle(() => assert.ok(flushes.length >= 3), INTERVAL * 8)

    const intervals = flushes.map(flush => flush.interval)
    assert.equal(new Set(intervals).size, intervals.length)
  })

  it('goes back to counting once an outage ends', async () => {
    const name = group()
    const { worker, outage } = injected(name)

    outage.fail()
    worker.increment(1)

    await settle(() => assert.ok(outage.failures() >= 2), INTERVAL * 6)
    assert.deepEqual(await totals(name), [])

    outage.heal()
    worker.increment(9)

    await settle(async () => assert.equal(sum(await totals(name)), 9), INTERVAL * 5)
  })

  it('lands nothing twice around a hanging flush', async () => {
    const name = group()
    const { worker, outage, flushes } = injected(name)

    worker.increment(1)

    await settle(() => assert.ok(flushes.length >= 1), INTERVAL * 4)

    outage.stall()
    await settle(() => assert.ok(outage.hanging() > 0), INTERVAL * 4)

    // Nothing else goes out while one flush is still in the air, so the buffer
    // just grows.
    const held = flushes.length
    await sleep(INTERVAL * 2)
    assert.equal(flushes.length, held, 'a second flush must not overtake a hanging one')

    outage.heal()
    worker.increment(4)

    await settle(() => assert.ok(flushes.length > held), INTERVAL * 5)

    const intervals = flushes.map(flush => flush.interval)
    assert.equal(new Set(intervals).size, intervals.length)
  })

  it('stops the tick on close', async () => {
    const name = group()
    const { worker, flushes } = injected(name)

    worker.increment(1)

    await settle(() => assert.ok(flushes.length >= 2), INTERVAL * 6)

    worker.increment.close()

    const held = flushes.length
    await sleep(INTERVAL * 3)
    assert.equal(flushes.length, held)
  })

  it('closes at once over a hanging flush', async () => {
    const name = group()
    const { worker, outage } = injected(name)

    outage.stall()
    worker.increment(1)

    await settle(() => assert.ok(outage.hanging() > 0), INTERVAL * 4)

    const at = Date.now()
    worker.increment.close()

    assert.ok(Date.now() - at < 50, 'close must not wait on anything')

    // The flush it walked away from comes back as a rejection; nothing is
    // listening for it any more, and that has to be uneventful.
    outage.heal()
    await sleep(INTERVAL)
  })

  it('is idempotent, and keeps counting locally afterwards', async () => {
    const name = group()
    const { worker } = injected(name)

    worker.increment(1)
    worker.increment.close()
    worker.increment.close()

    // The one it never got round to sending is still in the buffer: closing
    // sends nothing, so nothing after it leaves the process either.
    assert.equal(worker.increment(3).count, 4)
    assert.equal(worker.increment(4).count, 8)
  })
})
