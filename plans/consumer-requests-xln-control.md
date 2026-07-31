# Consumer requests from XLN-Control

Written by the agent modernizing `XLN-Control`
(`C:\Users\camer\git\Personal Projects\XLN-Control`), which is the primary consumer of
this library. Reviewed `XLN.js` at `2bcc343` (v0.6.4).

I have **not** edited anything in this repo. These are findings and requests for whoever
is doing the TypeScript/promises rewrite. Cameron asked that I leave this file for you
rather than touch the code.

Ordered roughly by how much it matters.

---

## 1. CRITICAL — response correlation is unsound, and promises make it worse

```js
send(str, callback) {
  if (callback)
    this.sock.once('data', data => callback(data.toString().replace(/\0/g, '').trim()));
  return this.sock.write(str + '\n');
}
```

`once('data')` handlers fire in registration order, one per `data` event. TCP does not
preserve message boundaries, so there are two distinct failure modes:

- **Coalescing** — two replies arrive in one segment. Handler 1 receives _both_ replies
  concatenated. Handler 2 then waits for the _next_ reply and receives it instead of its
  own. Every subsequent request is off by one, permanently, and silently.
- **Splitting** — one reply spans two segments. Handler 1 receives a truncated string
  (`parseFloat` on it may still succeed, producing a plausible wrong number).
  Handler 2 receives the tail.

Today this is _masked_, not avoided: XLN-Control's poll loop manually serializes every
request through chained callbacks, so there is only ever one outstanding query. That's
the only reason it works.

**A promise API removes that accident.** `await Promise.all([psu.getMeasuredVoltage(),
psu.getMeasuredCurrent()])` is the obvious thing a caller will write, and it will
silently return swapped or corrupted values. This is a wrong-numbers-on-a-power-supply
bug, not a crash.

Please build the rewrite on:

- A receive buffer that accumulates and splits on the actual terminator, rather than
  trusting `data` event boundaries.
- A FIFO of pending requests; each complete reply resolves the head. Only queries
  (`?` commands) take a slot — bare commands produce no reply and must not.
- A hard invariant that a reply arriving with an empty FIFO is an error (surfaced, not
  swallowed) — that's the signal that framing has desynchronized.

If for some reason the design keeps one-in-flight-at-a-time, please make that explicit
and internally queued, so concurrent callers are serialized _correctly_ rather than
being an undocumented requirement each consumer has to rediscover.

## 2. No timeouts — a lost reply hangs the caller forever

Nothing bounds how long a request waits. Please add a per-request timeout that rejects.

Note the subtlety: a late reply arriving _after_ a timeout re-desynchronizes the FIFO.
Rejecting the promise but leaving the connection up is not sufficient. Safest is to treat
a request timeout as fatal to the connection (fail all pending, emit disconnect, let
reconnect handle it). If you'd rather resync, it needs an explicit mechanism.

Please also support `AbortSignal` on requests and on connect.

## 3. Setters resolve before the device has done anything

```js
sendValue(str, val, callback) {
  var ret = this.send(str + ' ' + val);
  if (callback) callback(ret);      // ret is socket.write()'s boolean
  return ret;
}
```

`setSourceVoltage`, `setOutput`, `resetLatchedProtection`, etc. all "complete" with the
return value of `socket.write()` — i.e. TCP backpressure state, not device
acknowledgement. In promise form, `await psu.setOutput(true)` reading as "the output is
now on" would be actively misleading.

Options, in preference order:

1. Setters issue the command and then a synchronizing query (`*OPC?`, or `:SYS:ERR?` —
   see below) and resolve only when that returns. Correct, costs a round trip.
2. Setters resolve on flush and the docs say plainly that they are fire-and-forget, with
   an opt-in `{ confirm: true }` for the above.

Either is fine. Silently resolving with a boolean that means something else is not.

## 4. `:SYS:ERR?` exists but nothing ever reads it

An out-of-range or malformed setpoint is silently ignored by the supply. The only way to
find out is to poll `:SYS:ERR?`, which no consumer currently does (I wouldn't have known
to, either).

Request: either check the error queue automatically after setters (see above), or expose
a background error poll that emits errors as events. Consumers should not have to know
that a silent-failure mode exists in order to avoid it.

## 5. Everything comes back as a string

Every getter resolves the raw reply text. XLN-Control currently does
`current * this.state.measVoltage` — string coercion that happens to work — and
`.toFixed(3)` on it works by accident.

Requests for the TS API:

- Numeric getters return `number` (`:MEAS:VOLT?`, `:MEAS:CURR?`, `:FETC:*`,
  `:SOUR:*`, all the `:LIM:` and `:SR:` getters).
- Boolean getters return `boolean` (`:OUT?`, `:SYS:BEEP?`, `:SOUR:*:PROT?`).
- `:OUT:STAT?` returns a union type rather than `string`. XLN-Control only ever handled
  `'CV'` and `'CC'` with an else-branch, and neither of us knows the full set — worth
  confirming against hardware. **Please keep the raw string reachable** (a `.raw`, or a
  widened union with a passthrough) so an unexpected value degrades rather than throws.
- A parse failure should reject with the offending text included, not yield `NaN`.

## 6. `on('data')` / `once('data')` silently no-op

```js
on(evt, cb) {
  if (evt == 'data') return;      // returns undefined, no error, no events
  return this.sock.on(evt, cb);
}
```

A consumer subscribing to `data` gets silence and no indication why. In TypeScript the
clean fix is free: type the event map so `'data'` simply isn't a member, and the compiler
rejects it at the call site. (If you keep a runtime path, throw rather than return.)

## 7. `new Buffer(96)` is removed in modern Node

`udpXLN`'s constructor. Use `Buffer.alloc(96)`.

## 8. `udpXLN` is half-finished and misleadingly named

- `readStatus()` sends `MEAS:CURR?` — it reads _current_, not status.
- `parseUDPMessage()` is an identity function (`msg.toString()`, return).
- `send()` has the same `once('message')` correlation bug as the TCP path.
- No `close()` — the socket leaks.

**The question I actually care about:** what is UDP 9221 _for_ on these supplies? If it's
a discovery/broadcast channel, a `discover()` that broadcasts and yields the supplies it
finds would be the single most useful addition for XLN-Control, which currently hardcodes
a host in a committed JSON file. If it's just a second command channel, it may be worth
dropping rather than shipping half of it.

## 9. Auto-reconnect is left to every consumer

`tcpXLN.reconnect()` exists but nothing calls it on `close`. XLN-Control implements its
own reconnect handling, badly. An opt-in auto-reconnect with backoff, plus clear
`connected` / `disconnected` events, would let consumers delete that code.

Related: on disconnect, all pending requests must reject. Right now they'd just hang.

## 10. Constructor-with-callback isn't promise-shaped

`new tcpXLN(options, callback)` can't be awaited. Please prefer a static async factory:

```ts
const psu = await XLN.connect({ host, signal });
```

and add `close()` plus `[Symbol.asyncDispose]` so `await using` works.

## 11. Concurrent sessions to the instrument

Many SCPI instruments accept only one session, or interleave replies badly across two.
Worth determining against hardware and documenting. If it's genuinely unsafe, consider
whether the library should detect or refuse it — that's a footgun a consumer can't see.

## 12. Packaging

Current: `main: dist/XLN.js`, gulp + babel, no type declarations, CommonJS-ish with
stray `export class` in a `'use strict'` file.

Requests (matching what `react-smoothie` v2 did):

- `"type": "module"`, ESM output, an `exports` map.
- Ship `.d.ts`. Types are the main reason XLN-Control wants this rewrite.
- `sideEffects: false`.
- Replace gulp with `tsdown` (react-smoothie v2 uses it).
- **Publish a prerelease under a `next` dist-tag** so XLN-Control can depend on the new
  API before it stabilizes, rather than pinning a git URL.
- Keep `bun link` working from this directory — that's how I'd like to develop against
  the dev build in the meantime.

## 13. Optional / low priority

The ~40 flat methods (`getSourceOverVoltageLevel`, `setOutputCurrentSlewRate`, …) are
verbose but perfectly clear. Grouping them (`psu.source.voltage.get()`) would be churn
for taste. **Recommend leaving flat**, mentioned only so it's a considered decision.

---

## What I need to start, in priority order

1. The response-framing/queue fix (#1) — everything else is cosmetic next to it.
2. Typed numeric/boolean returns (#5).
3. A published prerelease or a working `bun link` (#12).
4. An answer on what UDP 9221 does (#8), which decides whether XLN-Control gets device
   discovery or keeps a configured host.

Note that Cameron has no XLN supply on the bench right now, so several of these need
hardware to settle. XLN-Control is building a fake SCPI supply
(`XLN-Control/src/sim`) that can deliberately coalesce, split, delay, and drop replies —
exactly the cases #1 has to survive. **You're welcome to use it as a test fixture.** Say
the word (via Cameron) if you'd rather it lived in this repo instead.

Reach me by replying in this file or leaving one alongside it — I'll check before making
API assumptions.
