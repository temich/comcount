# Distributed counting

Participants of a distributed system each count something locally — requests
served, jobs taken, bytes written — and each one needs the number the whole
group reached, not just its own.

The library keeps that total in Redis, one running sum per named counter per
interval, and hands every participant the group's number in exchange for its
own.

## Usage

```sh
npm install comcount
```

```ts
import { counter } from 'comcount'

const increment = counter({ redis, name: 'requests', interval: 5_000 })

// wherever the thing being counted happens
const { count } = increment(1)

if (count > BUDGET) shed()
```

`increment` is synchronous. It adds to a local buffer and hands back a number
that is already known — nothing in the calling path waits on Redis, and calling
it a thousand times costs a thousand additions, not a thousand round trips. The
buffer is sent on its own, once an interval, and the reply brings back what the
group came to.

### Options

| Option     |          |                                                                                                             |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `redis`    | required | An [ioredis](https://github.com/redis/ioredis) or [node-redis](https://github.com/redis/node-redis) client. |
| `name`     | required | Counter name, for example `requests`. Participants sharing it share a total.                                |
| `interval` | required | Interval length in milliseconds. See below on choosing one.                                                 |
| `prefix`   | `''`     | Prepended to the key, for namespacing.                                                                      |
| `console`  |          | Where to report what the counter is doing.                                                                  |

Nothing happens until the first `increment`: a counter that is never incremented
never opens a conversation with Redis.

## What `count` is

Not a report on the last interval. It is the best lower bound available on what
the group is counting right now:

```
count = max(
  the group's total over the last closed interval,
  this participant's own buffer, not yet sent
)
```

Both numbers understate the same thing, in different directions. The group's
total covers everyone but an interval that has already ended. The buffer covers
the interval still open but only one participant. Whichever is larger is the
closer bound, and the case for taking it is the case a smaller number would
miss: a participant that has on its own already outrun what the whole group did
last interval is not in a situation that reads quiet.

When the group's number is not known — nothing has come back yet, the previous
interval has no key, or nothing has refreshed it for two intervals — what is
left is the buffer, which at least is honest about being local.

So `count` is built for a threshold: `count > x` answers whether the group has
at least reached `x`, and never claims more than it can stand behind. It is not
built for reporting a rate to three digits.

## What it guarantees

**A participant adds to a given interval at most once.** No arrangement of
timers, retries or clock skew makes one contribute twice. The total is therefore
never overstated: whatever Redis holds for an interval was really counted, by
that many distinct participants, once each.

**It can understate.** Two things cost contributions, both by design:

- A flush whose reply never arrives takes its buffer with it. Whether the write
  reached the server is exactly what is unknown, so keeping the amount for the
  next interval is precisely how a total would come to be overstated. It is
  dropped instead, and reported as `flush failed`.
- A flush that arrives later than planned leaves the interval it was meant for
  empty.

Undercounting is the side this library is allowed to be wrong on, and it is
wrong on it deliberately.

## How it works

One Redis key per interval, holding the running total:

```
{requests}:57960298228
```

The interval number is computed inside a Lua script from the server's own clock,
so every participant agrees on which interval is which by construction, and the
clocks on the participants never enter the arithmetic. The script adds the
amount to the current interval's key and returns what the previous one came to.

The tick is the whole of the timing:

> Send the buffer. When the reply comes back, wait one interval. Send again.

That is what the guarantee rests on. If a flush ran on the server at `at`, the
reply reached the participant later than that, and the next flush is timed from
the reply — so the next one reaches the server no sooner than `at + interval`,
and lands in a strictly later interval. Nothing about it depends on the two
clocks agreeing, or on where in the interval the last flush happened to fall.

The price is on the other side. Each flush lands a round trip further into the
interval than the last, and eventually steps over the edge, leaving one interval
with no contribution from that participant. Roughly one interval in
`interval / round trip` is lost this way — one in five thousand at a five-second
interval over a fast link, one in a hundred at a hundred milliseconds. That is
an undercount, which is allowed.

Only one flush is ever in the air. A flush that hangs freezes the counter until
the client gives up on it, rather than letting a second one overtake it; while
that lasts, the group's total stops counting as known and `count` falls back to
the buffer.

Interval keys expire after three intervals. Nothing accumulates, and nothing has
to be cleaned up.

### Choosing an interval

> TL;DR: set it to 5 seconds.

The floor is a Redis round trip with room to spare: the interval has to be long
enough that losing one in `interval / round trip` of them to drift is a rounding
error rather than a tax.

Above that it is a straight trade. A longer interval means fewer round trips —
one per participant per interval, whatever the call rate — and a coarser,
staler number: `count` describes an interval that closed before the last flush,
so it can be up to two intervals behind. A shorter interval means a fresher
number, more round trips, and a larger share of intervals lost to drift.

### Shutting down

```ts
increment.close()
```

Synchronous, idempotent, and it sends nothing. There is no parting flush by
design: it would arrive sooner than an interval after the last one, which is the
single thing that could count a participant into the same interval twice. So the
buffer that has not been sent is lost, the same way a restart loses it.

After `close()` the counter keeps counting locally and keeps answering, but
nothing more leaves the process. The Redis client is yours; close it yourself.

## What this does not give you

**It is not exact.** It is a lower bound that never overstates. Anything that
needs the true number — billing, accounting — wants a different tool.

**It reports one interval, not a history.** There is no query API, no window
other than the interval, and no way to ask about an interval that has scrolled
off. What is not in the reply is gone in three intervals.

**A participant that dies loses its buffer**, up to one interval of counting.
Only a shorter interval narrows that.

**Failures never reach the caller.** `increment` does not throw for anything to
do with the network: a flush that fails or hangs costs its buffer and shows up
on the `console` if you pass one, as `flush failed` or `total went stale`. What
it does throw for is a mistake in the call — an amount that is not a safe
integer, or a counter built without a client.

**It is not a rate limiter.** It enforces nothing and holds no tokens. It tells
you a number the whole group agrees on; what to do at a threshold is yours.

## Redis Cluster

Keys are written as `{name}:N`. The braces are a hash tag, so every interval key
of a counter lands in one slot and the two keys the script touches are never
cross-slot.

## Diagnostics

The library writes nowhere of its own accord. Pass a `console` and it reports
what it is doing to that instead — anything with `trace`, `debug`, `info`,
`warn` and `error`, each taking a message and an attributes object. The global
`console` fits as it is:

```ts
counter({ redis, name: 'requests', interval: 5_000, console })
```

Messages are constants and every value travels in the attributes, the counter
`name` included, so lines group by message whatever the backend does with the
rest. A healthy counter never rises above `info`.

| level   | message            | attributes                    |
| ------- | ------------------ | ----------------------------- |
| `error` | `flush failed`     | `error`, `dropped`            |
| `warn`  | `total went stale` | `after`                       |
| `info`  | `counter started`  | `interval`, `prefix`, `store` |
| `info`  | `counter stopped`  |                               |
| `debug` | `flush completed`  | `interval`, `amount`, `count` |
| `debug` | `script loaded`    | `sha`                         |

## Development

The tests are integration tests: they need a Redis, and fail without one.

```sh
docker run --rm -p 6379:6379 redis:8-alpine

npm install
npm run check   # typecheck + lint + format check + tests
npm run build   # emits dist/
```

`REDIS_URL` points them elsewhere (default `redis://localhost:6379`), and
`TEST_INTERVAL` sets the interval they run at in milliseconds (default `300`).
A slower machine wants a larger one — CI uses `600`. A smaller one is worth a
run of its own: the tighter the interval, the harder the timing is pressed.

| script              | does                                   |
| ------------------- | -------------------------------------- |
| `npm run typecheck` | `tsc --noEmit`                         |
| `npm run lint`      | `oxlint .` (`lint:fix` to autofix)     |
| `npm run fmt`       | `oxfmt .` (`fmt:check` in CI)          |
| `npm test`          | `node --test` over `src/**/*.test.ts`  |
| `npm run build`     | `tsc -p tsconfig.build.json` → `dist/` |

`husky` runs `npm run check` on pre-commit and lints the message against
[conventional commits](https://www.conventionalcommits.org) on commit-msg.

## Branches and releases

- `dev` — the default branch. Changes land here through a pull request that
  passes `check` and carries an approving review.
- `release` — merging `dev` into it runs `semantic-release`, which derives the
  version from the commit messages, tags it, publishes the package to npm, and
  cuts a GitHub Release with the generated notes.

Commit messages are the release input, so `commit-msg` lints them against
[conventional commits](https://www.conventionalcommits.org). The version in this
repository's `package.json` is not bumped by the release — the git tags are the
record, and `semantic-release` sets the published version at publish time.

Publishing to npm authenticates over OIDC — npm trusted publishing, configured
against this repository and `release.yml`. No `NPM_TOKEN` secret is involved:
the workflow requests `id-token: write` and npm (>= 11.5.1, which Node 24
bundles) exchanges that for a short-lived credential, and stamps the release
with a provenance attestation.

The trust relationship itself is registry-side state, not repository state:

```sh
npm trust list comcount
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch and release procedure,
and [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## License

[MIT](LICENSE) © Artem Gurtovoi
