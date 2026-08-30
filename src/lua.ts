/**
 * Adds the caller's amount to the interval the server is in, and reports what
 * the interval before it came to.
 *
 * `KEYS[1]` is the hash-tag base for the counter, for example `{requests}`.
 * The interval key is built inside the script so that `N` is derived from the
 * server's own clock — every participant then agrees on `N` by construction,
 * and clock skew between them stops mattering. Both keys the script touches
 * carry the same hash tag, so they share a slot and it is safe under Redis
 * Cluster.
 *
 * `ARGV` is `[intervalMs, ttlMs, amount]`. The reply is `[N, present, previous]`,
 * where `present` says whether the previous interval's key was there at all: a
 * total may legitimately be negative, so absence cannot be carried by a
 * sentinel value.
 */
export const ADD = `
local interval = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local n = math.floor(now / interval)

local current = KEYS[1] .. ':' .. n
redis.call('INCRBY', current, amount)
redis.call('PEXPIRE', current, ttl)

local previous = redis.call('GET', KEYS[1] .. ':' .. (n - 1))

return { n, previous and 1 or 0, tonumber(previous) or 0 }
`
