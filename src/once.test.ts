import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  group,
  INTERVAL,
  recording,
  settle,
  sleep,
  start,
  sum,
  totals,
  type Flush,
  type Worker,
} from './harness.ts'

/** The guarantee, as one predicate: no interval was ever contributed to twice. */
const assertOncePerInterval = (flushes: Flush[]) => {
  const intervals = flushes.map(flush => flush.interval)

  assert.deepEqual(
    intervals,
    intervals.toSorted((a, b) => a - b),
    'flushes must run in interval order'
  )
  assert.equal(
    new Set(intervals).size,
    intervals.length,
    `a participant landed in one interval twice: ${intervals.join(', ')}`
  )
}

/** Feeds every participant a steady trickle, the way a real load would. */
const drive = async (workers: Worker[], rounds: number, step: number) => {
  for (let round = 0; round < rounds; round += 1) {
    for (const worker of workers) worker.increment(1)

    await sleep(step)
  }

  return rounds * workers.length
}

describe('once', () => {
  const running: Worker[] = []

  /** A participant whose every flush is recorded, as sent and as landed. */
  const spawn = (name: string) => {
    const flushes: Flush[] = []
    const worker = start({ name, interval: INTERVAL }, { wrap: inner => recording(inner, flushes) })

    running.push(worker)

    return { worker, flushes }
  }

  after(async () => {
    await Promise.all(running.map(worker => worker.close()))
  })

  it('sends one flush however often it is called', async () => {
    const name = group()
    const { worker, flushes } = spawn(name)

    for (let call = 0; call < 1000; call += 1) worker.increment(1)

    await settle(() => assert.ok(flushes.length > 0), INTERVAL * 3)

    // A thousand calls, one round trip: the buffer is what is sent, not each
    // contribution to it.
    assert.equal(flushes[0]!.amount, 1000)
    await settle(async () => assert.equal(sum(await totals(name)), 1000), INTERVAL * 3)
  })

  it('never lands two flushes in one interval', async () => {
    const name = group()
    const { worker, flushes } = spawn(name)

    worker.increment(1)

    await settle(() => assert.ok(flushes.length >= 8), INTERVAL * 12)

    assertOncePerInterval(flushes)
  })

  it('holds exactly what was flushed into each interval', async () => {
    const name = group()
    const participants = [spawn(name), spawn(name), spawn(name)]

    await drive(
      participants.map(({ worker }) => worker),
      40,
      INTERVAL / 8
    )
    await sleep(INTERVAL * 1.5)

    for (const { flushes } of participants) assertOncePerInterval(flushes)

    const recorded = new Map<number, number>()

    for (const { flushes } of participants)
      for (const flush of flushes)
        recorded.set(flush.interval, (recorded.get(flush.interval) ?? 0) + flush.amount)

    // Whatever is still in Redis has to be exactly the sum of what the
    // participants say they put there — no more, and nothing invented.
    for (const { interval, total } of await totals(name))
      assert.equal(total, recorded.get(interval), `interval ${interval} does not match`)
  })

  it('never overstates the group total', async () => {
    const name = group()
    const participants = [spawn(name), spawn(name), spawn(name)]

    const offered = await drive(
      participants.map(({ worker }) => worker),
      40,
      INTERVAL / 8
    )

    await sleep(INTERVAL * 1.5)

    const counted = sum(await totals(name))
    const flushed = participants.flatMap(({ flushes }) => flushes).reduce((a, f) => a + f.amount, 0)

    assert.ok(counted <= offered, `counted ${counted} of ${offered} offered`)
    assert.ok(flushed <= offered, `flushed ${flushed} of ${offered} offered`)

    // Undercounting is allowed, but a healthy run has no reason to: nothing
    // failed, so everything that was offered should have gone somewhere.
    assert.equal(flushed, offered)
  })
})
