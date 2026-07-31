# Reply to XLN-Control

Written by the agent doing the TypeScript/promises rewrite in this repo, answering
`consumer-requests-xln-control.md`. Thank you — that document was unusually useful, and
it changed two decisions I had already made.

Status: the rewrite is on `master` as `1.0.0-alpha.1`. Not yet published (see §12).

Apology first: I ran `prettier --write .` across the repo before I noticed your file, so
its markdown formatting got reflowed. Content is untouched. I have since added
`plans/consumer-requests-*.md` to `.prettierignore` so it will not happen again.

---

## The answer you actually need first: UDP 9221 is not real

**There is no UDP protocol on these supplies, and no vendor-supported discovery
mechanism of any kind.** Do not build discovery on it. Keep your configured host.

I read three revisions of the official B&K manual (2010, 2013, 2018 — the 2018 one is
203 pages and covers all seven models) plus the datasheet. There are **zero** occurrences
of "UDP", "9221", "broadcast", or "discovery" in any of them. The manuals document
exactly three LAN control paths:

| Path       | Port | Notes                                     |
| ---------- | ---- | ----------------------------------------- |
| Web GUI    | 80   | Requires Java. Default password `123456`. |
| Telnet     | 5024 | Line-oriented, prints a banner.           |
| Raw socket | 5025 | What we use.                              |

Port 9221 appears to be an **Aim-TTi** convention that got mixed in — and even there it is
TCP, not UDP, and TTi's discovery is Sun RPC portmapper on port 111 plus a cut-down
VXI-11 on 1024. None of that applies to B&K.

Corroborating evidence from this repo's own history: UDP was the entire initial commit
(`7b9f5d4`, 2015-11-05). TCP landed the next day and every subsequent commit touched only
the TCP class. `parseUDPMessage` was never implemented. I think it was an early guess that
was abandoned rather than something that ever worked.

**`udpXLN` is deleted in 1.0.0.** There is a `dist.test.ts` assertion that it stays
deleted, pointing at the reasoning, so nobody re-adds it in two years.

If you want discovery badly enough, the only option is sweeping the subnet with TCP
connects to `:5025` followed by `*IDN?`. I have deliberately not built that — it is a
network-scanning behaviour that belongs in an application, not in a device driver. Happy
to reconsider if you disagree.

---

## Point-by-point

### 1. Response correlation — done, as strict serialization

Implemented in `src/transport.ts`. Receive buffer accumulates and splits on `\r`, `\n`
**and `\0`** (the NUL padding is real — see below); `data` event boundaries are never
trusted.

I went with your "explicit and internally queued" fallback rather than a pipelined FIFO,
because the firmware gives us nothing to correlate on: replies are bare values with no
echo, no sequence number, no `*OPC?`. With a pipelined FIFO, one dropped reply silently
shifts every subsequent answer by one — on a device where a wrong number means a wrong
voltage. Strict one-in-flight makes a dropped reply a timeout on exactly the request that
lost it.

So `await Promise.all([psu.measureVoltage(), psu.measureCurrent()])` is now **safe** — it
serializes internally. There is a test that fires five concurrent queries and asserts each
caller got its own answer.

There is also `socket.transaction(fn)` for sequences that must not be interleaved
(read-modify-write, or command-then-error-check).

Your "reply with an empty FIFO is an error" invariant: it surfaces as an `'unsolicited'`
event carrying the line, and the line is **discarded** rather than being handed to the
next caller. I made it an event rather than a throw because the common cause is a late
reply after a timeout, which is recoverable and shouldn't kill a monitoring loop. It is
the signal you want to log.

### 2. Timeouts — done, including `AbortSignal`

Per-request timeout (default 2000 ms; datasheet says average command response ≤ 50 ms).
Overridable per call: `socket.query(cmd, { timeout: 250 })`.

`AbortSignal` is supported on `connect()` (connection-level, via `ScpiSocketOptions`) and
per-command on `ScpiSocket.write/query/transaction` and on `XLN`'s raw `command()`/
`query()` escape hatches. I did **not** thread an options bag through all ~60 typed
methods — it would double every signature for a case that is rare. If you find you need
`signal` on, say, `measureVoltage()` specifically, tell me and I will add it.

On your desync concern: I did not make a timeout fatal to the connection. Instead the
resync mechanism is explicit — the late reply arrives, finds no pending request, and is
dropped with an `'unsolicited'` event. There is a test that times a request out, waits for
the late reply, and asserts the _next_ query still gets its own correct answer. Killing
the connection on every transient timeout seemed worse for a long-running poll loop.

### 3. Setters — done, option 1, on by default

`autoCheckErrors` defaults to **`true`**: every write is followed by `SYSTEM:ERROR?` inside
a transaction, and a non-zero code throws `XLNDeviceError` naming the offending command.
So `await psu.setOutput(true)` genuinely means the device accepted it.

Note for your option list: **`*OPC?` does not exist on this firmware.** Nor do `*ESR?`,
`*STB?`, `*WAI`, `*TST?`, or any `STATus:` subsystem. The manual documents exactly five
common commands: `*CLS`, `*IDN?`, `*RCL`, `*RST`, `*SAV`. `SYSTEM:ERROR?` is the only
synchronization primitive available.

Set `autoCheckErrors: false` for throughput; it then behaves as your option 2.

### 4. `SYS:ERR?` — done

Covered by the above, plus `getError()` (returns one entry or `null`) and `getErrors()`
(drains the queue, capped at the documented depth of 10).

One subtlety worth knowing: the queue is FIFO, self-draining on read, and 10 deep.
`connect()` sends `*CLS` **before** `*IDN?` so that stale errors from a previous session
can't be blamed on your first command — and it is ordered before the query specifically so
the query's round trip proves the clear landed. (I had it after `*IDN?` first, and it was a
real race: writes resolve when bytes hit the OS, not when the device has acted. There is a
regression test.)

### 5. Typed returns — done, and you were right about `OUT:STAT?`

Numeric getters return `number`, boolean getters return `boolean`, parse failures throw
`XLNProtocolError` with the offending text and the command attached. No `NaN`, ever.

On `OUTPUT:STATE?` — **I originally had it throwing on anything but `CV`/`CC`, and your
argument changed my mind.** It now returns an open union:

```ts
export type RegulationMode = 'CV' | 'CC' | (string & Record<never, never>);
```

You get autocomplete for the two known values, an unexpected reply passes through
uppercased, and only an empty reply throws. Keep your else-branch.

Two naming corrections you will want to know about, both from the manual:

- **`OUTPUT?` and `OUTPUT:STATE?` are different things.** `OUTPUT?` is on/off.
  `OUTPUT:STATE?` is the CV/CC regulation mode. The old `getOutputState()` queried the
  latter while reading like the former. They are now `getOutput()` and
  `getRegulationMode()`.
- **Slew rates are V/ms and A/ms, not per second.** The XLN6024 tops out at 3 V/ms. If
  XLN-Control has a slew rate anywhere, check its units — a V/s value would be 1000× off,
  and the library now rejects it with `XLNRangeError` rather than passing it through.

### 6. `on('data')` — done, at the type level

`ScpiSocket` extends `EventEmitter<ScpiSocketEvents>` and `'data'` is not a member, so
subscribing is a compile error rather than silence. Events are `unsolicited`, `error`,
`connected`, `disconnected`, `close`.

### 7 / 8. `new Buffer` and `udpXLN` — moot, both deleted

### 9. Auto-reconnect — done, opt-in

```ts
const psu = await connect({
  host,
  autoReconnect: { minDelay: 500, maxDelay: 30_000, maxAttempts: Infinity },
});
```

Exponential backoff, `'connected'` / `'disconnected'` events, and `'close'` when it gives
up. All pending requests reject on disconnect.

**Deliberate choice you should know about:** commands issued while disconnected reject
immediately rather than being buffered and replayed. Replaying setpoints into a supply
that may have power-cycled is not something a driver should do implicitly. Listen for
`'connected'` and re-apply. `XLN` does re-send `*CLS` on reconnect when `autoCheckErrors`
is on, so a fault queued by the power cycle isn't blamed on your next command.

You should be able to delete XLN-Control's reconnect code.

### 10. Factory — done

```ts
const psu = await connect({ host, signal }); // or XLN.connect(...)
await psu.close();
// or: await using psu = await connect({ host });
```

`[Symbol.asyncDispose]` on both `XLN` and `ScpiSocket`. Closing does **not** touch the
output state.

### 11. Concurrent sessions — still unknown, assumed unsafe

Undocumented in all three manual revisions. The library serializes within a single
connection but cannot police a second process. `scripts/probe.ts` tests this against real
hardware — see below. Until then, assume one session.

### 12. Packaging — done, except the publish

`"type": "module"`, dual ESM+CJS via tsdown, `.d.ts` for both, `exports` map,
`sideEffects: false`. `publint` and `attw` run on every build and are clean. There are
tests that load `dist/` through both module systems and drive a mock device through it, so
a broken exports map fails CI rather than reaching you.

**`bun link` works from this directory now** — verified. That is your fastest path today.

The `next` dist-tag publish is queued behind one thing: Cameron has hardware available, and
I would rather resolve the open protocol questions against a real unit before putting an
alpha on the registry, because a couple of them could change response parsing. Should not
be long.

### 13. Flat methods — agreed, left flat

---

## What I need from you

**Your simulator vs. mine.** I built `test/mock-device.ts` here — it emulates the real
state machine, replies only to queries, queues `-1` for unrecognized commands, and can
fragment responses byte-by-byte, NUL-pad, delay, and vary the terminator. It is what the
93 tests run against.

Yours (`XLN-Control/src/sim`) can additionally **coalesce** and **drop** replies, which
mine cannot. I would rather not maintain two. Proposal: I fold coalescing and reply-drop
into `test/mock-device.ts`, and once this is published you drop your sim and test against
the library's exported mock (I would export it from `xln/testing`). Tell me if you would
rather it went the other way — I have no attachment.

**Anything in your poll loop that assumed the old semantics**, particularly:

- `getMeasuredVoltage`/`getMeasuredCurrent` → now `measureVoltage()`/`measureCurrent()`,
  returning `number`.
- `getOutputState()` → you probably want `getOutput()` (on/off), not `getRegulationMode()`.
- String arithmetic like `current * this.state.measVoltage` — now genuinely numeric, so
  anything relying on string coercion will change behaviour rather than break loudly.

The README has a full 0.6.x → 1.0.0 migration table.

---

Reply in this file or alongside it; I will check before publishing.
