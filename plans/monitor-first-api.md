# Monitor-first API: UDP readers, scoped control

## Goal

Let many clients read live state from one supply without any of them interfering
with the single client that is driving it. Today every consumer of this library
opens a TCP/SCPI session just to read a voltage, so a dashboard, a logger and a
control script are three TCP sessions against a device whose tolerance for that
is unknown.

The UDP status channel already solves the read side — it is connectionless,
stateless and monitor-only. What is missing is an API that makes "read without
connecting" the obvious default, and makes holding a TCP session a deliberate,
scoped act.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\XLN`, branch `master`, Bun + vitest.
- Version: `1.0.0-alpha.1`. **Pre-release — breaking changes are cheap right now.**
  This is the reason to do the rename in this change rather than layering.
- Hardware: an XLN6024 on firmware 1.20 at `10.255.14.231`. Shared with the
  XLN-Control project; see the `workspace-contention` skill before connecting.
- Downstream consumer: XLN-Control (the GUI, formerly jsXLN). It already plans to
  move its poll loop to UDP — see `plans/consumer-requests-xln-control-round-4.md` §3.

## Decisions already made (don't re-ask)

1. **Rename both entry points; no legacy `connect()`.** `watch()` for the UDP
   monitor, `control()` for a TCP session. Rationale: with two genuinely
   different kinds of connection, `connect` no longer names anything specific.
   Pre-release is the moment to pay this once.
2. **Scoped `withControl(fn)` only on the monitor — no `takeControl()` disposable.**
   A scoped callback cannot leak a session. Long-running apps that legitimately
   own the supply use top-level `control()` instead; that is the escape hatch that
   makes "scoped only" tolerable.
3. **The monitor coalesces polling.** `subscribe()` runs one shared poll loop and
   fans out, so N readers in a process produce one datagram stream.
4. **No transparent per-call TCP.** `monitor.setVoltage(12)` silently opening a
   socket was rejected — it hides connection churn on a device whose reaction to
   churn is untested.

## Load-bearing facts (verified — do not re-litigate)

- **RESOLVED 2026-08-02: the device does NOT evict, and concurrent TCP sessions
  are safe.** Measured on the XLN6024 at 10.255.14.231, fw 1.20, by
  `scripts/probe-contention.ts` and `scripts/probe-contention-deep.ts`:
  - **12 concurrent sessions** all connected and answered `*IDN?`. 12 was the
    search bound, not a device limit — no refusal was ever observed.
  - The **oldest** session still answered normally with all 12 open. No FIN, no
    RST, no eviction of any kind at any point.
  - **150 queries across 6 simultaneous sessions, 0 crossed replies.** Each
    session repeatedly asked a command with a reply unique to it
    (`*IDN?`, `SOURCE:VOLTAGE?` = 24.000, `SOURCE:CURRENT?` = 6.000,
    `OUTPUT:STATE?` = OFF, OVP = 8.500, OCP = 26.000) so a misrouted reply
    would have been unmistakable. Every reply went to the right socket.
  - **10/10 connect -> query -> close churn cycles** succeeded, ~50 ms per cycle
    excluding the deliberate pause. No wedging.
  - Unit healthy after every run.

  This **falsifies the round-3 eviction claim outright**, and retires the
  "assumed unsafe" position that round 4 left standing. The stale
  `workspace-contention` marker `4a7c072c.md` still asserts the retracted claim
  as a hard warning and should be corrected or removed.

- **RESOLVED 2026-08-02: concurrent _writes_ are coherent too.** Measured by
  `scripts/probe-contention-writes.ts` (setpoints only, output never enabled,
  originals restored):
  - **Device state is shared, not per-session.** A setpoint written on session A
    reads back immediately and correctly on sessions B and C, and vice versa.
    There is no per-connection shadow state to reconcile.
  - **20/20 rounds of two sessions writing conflicting voltages simultaneously**
    (5.000 vs 7.000) settled on one of the two requested values. No torn,
    averaged or garbage values — writes are atomic at the setpoint level.
  - **30/30 reads on a third session stayed correct under concurrent write load**
    from the other two. Write traffic does not desynchronize a reader's stream.
  - **Error queue clean afterwards.**
  - Last-writer-wins, with no corruption. Two controllers fighting is still a
    logical hazard for the _application_, but not a protocol-level one.

- **Consequence for this design:** contention-avoidance is no longer a reason
  for anything here. The monitor is still worth building — it gives a coherent
  single-instant sample, costs no TCP session, and is the right shape for N
  readers — but scoped/light-touch control is now an _optimization_, not a
  safety measure, and must not be documented as one.

- **RESOLVED 2026-08-02: the monitor-first premise works end-to-end on hardware.**
  `scripts/probe-monitor-live.ts` ran a `UdpStatusChannel` poll loop while a
  wholly independent SCPI session drove the supply (output enabled at 5 V, no
  load, restored afterwards):
  - Monitor saw the output go ON **254 ms** after the TCP session enabled it,
    and tracked a 5 V -> 6.5 V setpoint change in **235 ms**. Both numbers are
    dominated by the probe's own 100 ms poll interval plus 50 ms check
    granularity — they are _not_ device latency, and a tighter loop will do
    better. Do not quote them as a device characteristic.
  - **UDP and SCPI agreed exactly**: state `CV`/`CV`, voltage 6.500/6.500,
    delta 0.000 V. The UDP frame is not a stale or separately-sampled copy.
  - **42 samples, 0 poll errors**, with a TCP control session open throughout.
  - Restored to the original 24 V / 6 A / output OFF exactly.

- **Sustained UDP poll rate measured 15.2 Hz here**, against the ~21 Hz recorded
  earlier. The difference is most likely the concurrent TCP control session and
  live output; it was not isolated. Treat ~15-21 Hz as the honest range and keep
  describing the ceiling as RTT-bound rather than a device limit.

- **CC remains unobserved.** With nothing connected there is no load to force
  current limiting, and lowering the limit does not help: `SOURCE:CURRENT 0` is
  rejected outright, and 0.1 A / 0.01 A still report `CV` at 0.000 A. Capturing
  CC needs a real load. **The `RegulationMode` type must stay open** rather than
  being narrowed to the states we happen to have seen.

- **NEW, undocumented: this device emits POSITIVE error codes.**
  `SOURCE:CURRENT 0` produces `SYSTEM:ERROR?` -> **4**. Every code in
  `src/parse.ts:59` is 0 or negative (-1..-12), taken from the manual, so the
  library renders this as "Unknown error code 4". Meaning is unconfirmed;
  "parameter out of range" is the obvious guess given what triggered it, but it
  has not been tested against other out-of-range parameters. Worth mapping
  before 1.0.0 — safely, using out-of-range parameters on _supported_ commands,
  never the unsupported command forms that wedge the unit.

- **This unit's stored config is internally inconsistent — do not "fix" it.**
  Found at `SOURCE:VOLTAGE 24.000` with `OVP 8.500`. Enabling the output as
  configured would trip over-voltage protection immediately. Flagged to Cameron;
  left exactly as found. Any probe that writes setpoints must stay below 8.5 V
  and restore what it found.

- **A first-probe result that did NOT hold up, recorded so nobody reuses it:**
  the first probe's crossed-reply check asked A for `MEAS:VOLT?` and B for
  `MEAS:CURR?` with the output off. Both correct answers were `"0"`, so it could
  not have detected crossing at all. It was re-run with distinct replies. Beware
  concurrency tests whose expected values collide.
- **UDP is monitor-only and gives measured state only**: `state`, `voltage`,
  `current`, `power`. Setpoints, limits, protection config, the error queue and
  identity are all SCPI-only. A "read-only client" that needs a setpoint still
  needs TCP. See `src/udp.ts:1`.
- **UDP is unicast; broadcast gets nothing.** Not discovery. Host must be configured.
- **UDP is strictly request/response**, ~21 Hz sustained poll-on-reply, RTT-bound.
  Vendor applet polls at 2 Hz.
- **The firmware wedges off the network from unsupported command forms**
  (`plans/xln-modernization.md:512`), and resets rather than closing gracefully
  (`ECONNRESET` on `end()`). Rapid connect/disconnect churn is a plausible second
  wedging vector and **has never been tested**. This is why light-touch is offered
  but its churn characteristics stay documented as unverified.

## Things not to do

- **Do not name or document `withControl` as a lock, mutex, lease or claim.** The
  device has no locking primitive. Two processes on two machines both succeed.
  The serialization we provide is _in-process only_. If the API implies mutual
  exclusion someone will build a safety interlock on it.
- Do not add an `'evicted'` event or reconnect circuit breaker (retracted premise).
- Do not expose raw `command()`/`query()` any more prominently than today — the
  wedging risk is real and XLN-Control has written it into its own "do not do" list.
- Do not make the UDP monitor silently fall back to TCP polling. That reintroduces
  exactly the hidden TCP session this feature exists to remove.

## Design

```ts
// Read-only. Opens a UDP socket, never a TCP one.
const supply = await watch({ host: '10.255.14.231' });

await supply.poll(); // -> UdpStatus, one datagram
const stop = supply.subscribe(onStatus, { intervalMs: 500 });

// Light touch: TCP open for exactly the duration of the callback.
await supply.withControl(async (psu) => {
  await psu.setVoltage(12);
  await psu.setOutput(true);
});

// Long-held session, for the one client that owns the supply.
await using psu = await control({ host: '10.255.14.231' });
```

Types: `XLNMonitor` (from `watch`) and `XLN` (from `control`, keeps its name and
its full method surface). The read-only guarantee is structural — `XLNMonitor`
simply has no setters, so TypeScript rejects a write at compile time.

### Details settled during design

- `watch()` probes UDP once and **rejects** if the device does not answer. There
  is no fallback by design, so a monitor that cannot poll is a failed construction,
  not a degraded object.
- `withControl` reuses the monitor's existing UDP channel for `measure()` inside
  the session — no second probe, and measurements stay coherent.
- The monitor **caches identity and model spec** after the first control session,
  so later `withControl` calls skip `*IDN?`. Saves a round trip per light touch.
- **Overlapping `withControl` calls in one process are serialized**, not run in
  parallel — one TCP session at a time. In-process only; see "things not to do".
- The shared poll loop starts on first subscriber, stops on last unsubscribe, and
  **skips rather than overlaps** if a poll is still in flight. Poll errors go to an
  `onError` option; a single timeout must not kill the loop.
- UDP polling continues normally while a control session is open — the two
  transports are independent.

## Settled after the hardware probes

5. **`monitor.readSettings()` opens a brief TCP session** to read setpoints,
   limits and protection config, rather than caching values from control
   sessions. Now provably safe to do alongside an active controller. Chosen over
   caching because a cached setpoint is stale by construction, and a stale
   setpoint displayed as current is exactly the thing someone trusts.
6. **`control()` returns a disposable** (`await using`), as the long-lived
   escape hatch that makes decision 2's scoped-only `withControl` tolerable.

## Open questions for the user

1. **Does `withControl`'s in-process serialization still earn its place?** It was
   designed to keep TCP sessions from overlapping, and overlapping is now proven
   harmless. Keeping it makes concurrent callers deterministic; dropping it is
   simpler and matches the device. Leaning keep — it costs nothing and makes
   last-writer-wins predictable within one process — but it must be documented as
   ordering, not safety.
2. **Map error code 4** before 1.0.0? Cheap and safe to probe; see findings.

## Plan / steps

- [ ] 1. `XLNMonitor` in `src/monitor.ts` — wraps `UdpStatusChannel`, adds
      `poll()`, `subscribe()`, shared loop, `close()`.
- [ ] 2. `watch()` entry point with the availability probe.
- [ ] 3. `withControl(fn)` — scoped TCP, serialized, identity cache, UDP reuse.
- [ ] 4. Rename `connect()` -> `control()`; drop the old name entirely.
- [ ] 5. Update `src/index.ts` exports.
- [ ] 6. Tests: monitor against `MockDevice`, subscriber fan-out (one datagram
      stream for N listeners), `withControl` closes TCP on throw, serialization
      of overlapping calls.
- [ ] 7. README: lead with the monitor; rewrite the migration table for the rename.
- [ ] 8. CHANGELOG entry.
- [ ] 9. Verify on hardware at `10.255.14.231` (check contention markers first).

## Progress log

- [x] 2026-08-02 — Design settled with Cameron. Three structural decisions locked.
- [x] 2026-08-02 — **Probed TCP contention on hardware before building anything.**
      Cameron asked for this before further changes; it was the right call. The
      eviction premise is falsified, not merely unproven: 12 concurrent sessions,
      0 crossed replies in 150 concurrent queries, coherent concurrent writes.
      Scripts: `probe-contention.ts`, `probe-contention-deep.ts`,
      `probe-contention-writes.ts`.
- [x] 2026-08-02 — **Validated the monitor-first premise end-to-end** with the
      output energized (`probe-monitor-live.ts`). UDP monitor tracked an
      independent TCP session's changes; UDP and SCPI agreed exactly.
- [x] 2026-08-02 — Supply restored to as-found state (24 V / 6 A / output OFF)
      and independently verified. Contention marker released.
- [ ] Next: build the monitor (step 1 below).

### Self-inflicted mistakes from this session, so they are not repeated

- The first crossed-reply test compared two commands that both answered `"0"`
  with the output off. It could not have detected crossing. **A concurrency
  test whose expected values collide proves nothing** — baseline for uniqueness
  first, as `probe-contention-deep.ts` now does.
- `probe-contention-writes.ts` applied its voltage safety ceiling to its own
  restore step, refusing to write back the as-found 24 V and leaving the supply
  on a test setpoint. Nothing was energized, and it was restored manually. Guard
  now exempts restores. **A safety guard that blocks cleanup is a safety bug.**
- The probe treated `SYSTEM:ERROR?` -> `0` as an error because it only matched
  the text "no error". This device answers a bare `0`.

## Findings / gotchas

- The obvious probe for the UDP channel gives the wrong answer: a plain
  `*IDN?\r\n` over UDP gets silence. Only the datagram _length_ matters (even,
  <= 96 bytes). This is why the channel looked dead for years.
