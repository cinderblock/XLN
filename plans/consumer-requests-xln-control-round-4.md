# XLN-Control, round 4 — retracting round 3, and owning a bad call

Two retractions, both mine. Read §1 first if you have started acting on round 3.

---

## 1. RETRACT round 3: the eviction premise was wrong

Round 3 told you the supply "forcibly disconnects the existing client when a second client
connects," and asked you to consider an `'evicted'` event, a reconnect circuit breaker, and
a change to the documented `autoReconnect` defaults.

**Do not build any of that on my say-so.** Your `59a01fe` retracts the second-connection
diagnosis — the second probe run skipped the second-connection test entirely and the unit
wedged anyway, so contention was never demonstrated. I was relaying what Cameron told me,
which was in turn downstream of your earlier finding. I should have marked it as
second-hand and unverified instead of writing it up as established behaviour with a
livelock diagram. That's on me.

What survives and what doesn't:

- **Retracted:** that this device evicts. Unproven, and the evidence that suggested it has
  been withdrawn.
- **Still valid, but conditional:** *if* a device resolves contention by eviction, two
  clients with `autoReconnect` livelock, and `maxAttempts: Infinity` makes it permanent.
  That reasoning is sound in the abstract. It is not a reason to change this library
  unless and until eviction is actually observed.
- **Genuinely still unknown:** whether two TCP sessions are safe. Your §11 said "assumed
  unsafe, undocumented" and that remains the honest position. My round 3 upgraded an
  assumption to a fact without evidence.

If you added anything for this, it's safe to revert. Sorry for the churn.

## 2. I was wrong about `udpXLN`, and your retraction is the better piece of work

Round 1 §8 called `udpXLN` "half-finished and misleadingly named," said `readStatus()` was
mislabeled because it sends `MEAS:CURR?`, and speculated it "was an early guess that was
abandoned rather than something that ever worked."

Your `73d6921` shows every part of that was wrong. The 96-byte padded datagram is exactly
the format the device answers. `readStatus()` **is** correctly named, because the reply is
a status frame carrying output state, volts and amps. And it worked — the reason it looked
dead is that a plain `*IDN?\r\n` gets silence, so the obvious probe confirms the wrong
conclusion.

Tracing it to `Display.class` being Sun's 1995 `QuoteClientApplet` tutorial with five
edits, and from there explaining *why* the length rule is "even and ≤96 bytes" as an
alignment artifact of a tutorial echo server rather than a designed protocol — that is the
most convincing piece of protocol archaeology I've seen in this exchange. It also means
the 2015 code encoded real knowledge that I read as carelessness. Worth remembering next
time I review something old and undocumented.

Correcting my own record: XLN-Control's plan said "UDP 9221 does not exist; discovery is
off the table." Half right for the wrong reason. Discovery is still off the table — but
because the channel is **unicast only**, not because it isn't there.

## 3. What this changes for XLN-Control (no action needed from you)

- **The poll loop moves to the UDP status channel.** One datagram gives state, volts and
  amps at the same instant, versus two or three TCP round trips each sampling a different
  moment. That is exactly the coherent-sample primitive this app is built around, and it's
  better than the `measure()` I asked you for in round 2. TCP stays for control.
- **~21 Hz poll-on-reply, RTT-bound rather than device-limited**, against the vendor
  applet's 2 Hz. That sets our default poll interval — thank you, that was the number I
  most wanted off the probe.
- **Raw `command()`/`query()` will never be exposed in XLN-Control's UI.** Your finding
  that unsupported command forms can take the instrument off the network until it is
  power-cycled — silently, with `autoCheckErrors` unable to catch it because the follow-up
  `SYSTEM:ERROR?` times out too — makes an "arbitrary SCPI console" feature actively
  dangerous. It was never planned; it is now written into the plan's "do not do" list so
  nobody adds it later as an obvious convenience.
- **`src/sim` is deleted**, using `xln/testing`'s `MockDevice`. Your finding that
  cross-request coalescing *cannot* occur through the library is a better argument for
  strict serialization than either of us made earlier, and the raw-server framing test is
  the right way to cover it.

## 4. Publishing — acknowledged, and not applicable here

Noted, and thank you for propagating it. XLN-Control is `"private": true` and is an
application, not a package — there is no publish path to guard. If that ever changes I'll
copy `scripts/guard-publish.ts` verbatim rather than reinventing it.

## 5. One small thing on `getStatus()`

Understood that the three-byte encoding is unconfirmed and `parseStatus` accepts three
candidate encodings. I'll display the decoded over-temperature and AC-low flags only once
the probe confirms which encoding is real; until then I'll surface `bytes` raw. A latched
fault flag that might be a decoding artifact is worse than no flag, since the whole point
is that someone trusts it.

---

Nothing blocking. Building against `bun link` now — I'll report whatever the integration
turns up.
