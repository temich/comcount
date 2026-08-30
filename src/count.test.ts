import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  connect,
  faulty,
  group,
  INTERVAL,
  settle,
  sleep,
  start,
  type Fault,
  type Worker,
} from './harness.ts'
import { redisStore } from './store.ts'

describe('count', () => {
  const running: Worker[] = []
  const connections: ReturnType<typeof connect>[] = []
  const faults: Fault[] = []

  const spawn = (name: string) => {
    const worker = start({ name, interval: INTERVAL })
    running.push(worker)

    return worker
  }

  /** A participant whose store a test can cut off, always released afterwards. */
  const injected = (name: string) => {
    const redis = connect()
    connections.push(redis)

    const outage = faulty(redisStore(redis, { name, interval: INTERVAL }))
    faults.push(outage)

    const worker = start({ name, interval: INTERVAL }, { wrap: () => outage.store })
    running.push(worker)

    return { worker, outage }
  }

  after(async () => {
    for (const outage of faults) outage.heal()

    await Promise.all(running.map(worker => worker.close()))
    await Promise.all(connections.map(redis => redis.quit()))
  })

  it('reports its own buffer before anything is known', () => {
    const worker = spawn(group())

    // Nothing has been sent yet — the flush is armed on a timer, so it cannot
    // have run inside this call.
    assert.equal(worker.increment(5).count, 5)
    assert.equal(worker.increment(3).count, 8)
  })

  it('reports the group total once an interval has closed', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name)]

    for (const worker of workers) worker.increment(10)

    // Ten each, and the buffer is empty by then, so nothing but the group's
    // own number can produce twenty.
    await settle(() => assert.equal(workers[0]!.increment(0).count, 20), INTERVAL * 4)
  })

  it('takes the larger of the group total and its own buffer', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name)]

    for (const worker of workers) worker.increment(10)

    await settle(() => assert.equal(workers[0]!.increment(0).count, 20), INTERVAL * 4)

    // The group's last interval came to twenty; this participant has on its own
    // already outrun that, and the larger number is the one that gets reported.
    assert.equal(workers[0]!.increment(80).count, 80)
  })

  it('falls back to its own buffer when the tick stalls', async () => {
    const name = group()
    const { worker, outage } = injected(name)

    // Two of them, so the group's twenty can never be mistaken for one
    // participant's own ten sitting unsent in the buffer.
    for (const each of [worker, spawn(name)]) each.increment(10)

    await settle(() => assert.equal(worker.increment(0).count, 20), INTERVAL * 4)

    outage.stall()

    // The total it is still holding stops counting as known once nothing has
    // refreshed it for two intervals.
    await sleep(INTERVAL * 3)
    assert.equal(worker.increment(0).count, 0)
    assert.equal(worker.increment(4).count, 4)
  })

  it('falls back to its own buffer after close', async () => {
    const name = group()
    const workers = [spawn(name), spawn(name)]
    const worker = workers[0]!

    for (const each of workers) each.increment(10)

    await settle(() => assert.equal(worker.increment(0).count, 20), INTERVAL * 4)

    worker.increment.close()

    assert.equal(worker.increment(0).count, 0)
    assert.equal(worker.increment(7).count, 7)
  })
})
