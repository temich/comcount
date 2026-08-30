import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import type { Console } from './console.ts'
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

/** Every message the library is allowed to write. */
const MESSAGES = new Set([
  'counter started',
  'counter stopped',
  'flush completed',
  'flush failed',
  'script loaded',
  'total went stale',
])

interface Line {
  level: keyof Console
  message: string
  attributes: Record<string, unknown>
}

/** A console that does the worst thing a console can do. */
const angry = () => {
  throw new Error('console is broken')
}

/** A console that keeps what it was told, for the assertions to read back. */
const recorder = () => {
  const lines: Line[] = []

  const push = (level: keyof Console) => (message: string, attributes: Record<string, unknown>) => {
    lines.push({ level, message, attributes })
  }

  return {
    lines,
    console: {
      trace: push('trace'),
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    } satisfies Console,
    /** Every line carrying a given message. */
    at: (message: string) => lines.filter(line => line.message === message),
    /** Everything the library considers a problem. */
    raised: () => lines.filter(line => line.level === 'warn' || line.level === 'error'),
  }
}

describe('console', () => {
  const running: Worker[] = []
  const connections: ReturnType<typeof connect>[] = []
  const faults: Fault[] = []

  const injected = (name: string, console: Console) => {
    const redis = connect()
    connections.push(redis)

    const outage = faulty(redisStore(redis, { name, interval: INTERVAL }))
    faults.push(outage)

    const worker = start({ name, interval: INTERVAL, console }, { wrap: () => outage.store })
    running.push(worker)

    return { worker, outage }
  }

  after(async () => {
    for (const outage of faults) outage.heal()

    await Promise.all(running.map(worker => worker.close()))
    await Promise.all(connections.map(redis => redis.quit()))
  })

  it('writes nothing but the messages it declares, and never bare', async () => {
    const name = group()
    const log = recorder()
    const worker = start({ name, interval: INTERVAL, console: log.console })
    running.push(worker)

    worker.increment(1)

    await settle(() => assert.ok(log.at('flush completed').length >= 2), INTERVAL * 6)

    worker.increment.close()

    for (const line of log.lines) {
      assert.ok(MESSAGES.has(line.message), `undeclared message ${line.message}`)
      assert.equal(line.attributes.name, name, `${line.message} must say which counter it is`)
    }

    assert.equal(log.at('counter started').length, 1)
    assert.equal(log.at('counter stopped').length, 1)
  })

  it('stays at info while nothing is wrong', async () => {
    const name = group()
    const log = recorder()
    const worker = start({ name, interval: INTERVAL, console: log.console })
    running.push(worker)

    worker.increment(1)

    await settle(() => assert.ok(log.at('flush completed').length >= 4), INTERVAL * 10)

    assert.deepEqual(log.raised(), [])
  })

  it('reports a failed flush, and what it took with it', async () => {
    const name = group()
    const log = recorder()
    const { worker, outage } = injected(name, log.console)

    outage.fail(1)
    worker.increment(6)

    await settle(() => assert.equal(log.at('flush failed').length, 1), INTERVAL * 5)

    const [failure] = log.at('flush failed')

    assert.equal(failure!.level, 'error')
    assert.equal(failure!.attributes.dropped, 6)
    assert.ok(failure!.attributes.error instanceof Error)
  })

  it('reports a total that nothing is refreshing', async () => {
    const name = group()
    const log = recorder()
    const { worker, outage } = injected(name, log.console)

    // A second participant, so a total is known before the stall — there is
    // nothing to go stale otherwise.
    const other = start({ name, interval: INTERVAL })
    running.push(other)

    worker.increment(10)
    other.increment(10)

    await settle(() => assert.equal(worker.increment(0).count, 20), INTERVAL * 5)

    outage.stall()

    await settle(() => assert.equal(log.at('total went stale').length, 1), INTERVAL * 6)
    assert.equal(log.at('total went stale')[0]!.level, 'warn')
  })

  it('is not broken by a console that throws', async () => {
    const name = group()
    const broken: Console = {
      trace: angry,
      debug: angry,
      info: angry,
      warn: angry,
      error: angry,
    }

    const worker = start({ name, interval: INTERVAL, console: broken })
    const other = start({ name, interval: INTERVAL })
    running.push(worker, other)

    worker.increment(10)
    other.increment(10)

    // Twenty can only come from a round trip that happened, so the tick ran
    // through every line the broken console threw on.
    await settle(() => assert.equal(worker.increment(0).count, 20), INTERVAL * 6)

    worker.increment.close()
    await sleep(INTERVAL)
  })
})
