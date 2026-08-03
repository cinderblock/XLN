# xln

Remote control for **B&K Precision XLN series** programmable DC power supplies,
over SCPI on TCP port 5025.

Promise-based, fully typed, zero runtime dependencies.

```bash
npm install xln@next
```

> **1.0.0 is a breaking rewrite of the 2015 API.** If you are upgrading from
> 0.6.x, read [Migrating from 0.6.x](#migrating-from-06x) — the old callback API
> had a protocol bug that could silently return the wrong readings.

## Quick start

```ts
import { connect } from 'xln';

await using psu = await connect({ host: '192.168.1.50' });

console.log(psu.identity.model); // 'XLN6024'

await psu.setVoltage(12); // volts
await psu.setCurrent(1); // amps
await psu.setOutput(true);

const amps = await psu.measureCurrent(); // a number, not a string
console.log(amps > 0 ? 'Load detected' : 'No load');
```

`await using` closes the connection when the block exits. Note the **syntax**
itself is only native from **Node 24** — on Node 20 or 22 you need TypeScript or
another transpiler to downlevel it, or just call `await psu.close()`, which
works everywhere. Closing never changes the output state.

## Before you can connect

- **Ethernet only exists on `-GL` models.** A plain XLN6024 has USB, RS-485 and
  analog control only.
- **The interface must be selected on the front panel**, once:
  System Setting → Remote Control → **Ethernet**, then set a **static** IP.
  DHCP is not offered on these supplies.
- The device is assumed to accept **one session at a time**. This library
  serializes everything on its own connection, but it cannot stop a second
  process from interfering.

## Supported models

Limits are enforced client-side, before anything is transmitted, based on the
model reported by `*IDN?`.

| Model    | Voltage     | Current         | Power  | V slew (V/ms) | I slew (A/ms) |
| -------- | ----------- | --------------- | ------ | ------------- | ------------- |
| XLN3640  | 0–36 V      | 0–40 A          | 1440 W | 0.01–2.4      | 0.01–2.5      |
| XLN6024  | 0–60 V      | 0–24 A          | 1440 W | 0.01–3        | 0.01–1.2      |
| XLN8018  | 0–80 V      | 0–18 A          | 1440 W | 0.01–3.2      | 0.01–0.72     |
| XLN10014 | 0–100 V     | 0–14.4 A        | 1440 W | 0.01–3.3      | 0.01–0.48     |
| XLN15010 | **5**–150 V | **0.04**–10.4 A | 1560 W | 0.01–1        | 0.001–0.104   |
| XLN30052 | **5**–300 V | **0.02**–5.2 A  | 1560 W | 0.01–3.3      | 0.001–0.052   |
| XLN60026 | **5**–600 V | **0.01**–2.6 A  | 1560 W | 0.01–6.6      | 0.001–0.026   |

Note the **non-zero minimums** on the high-voltage models, and that **slew rates
are per millisecond, not per second**.

If `*IDN?` reports a model that isn't listed, range checking is skipped rather
than guessed at. Force it with `connect({ host, model: 'XLN6024' })`.

## Behaviour worth knowing

### Commands are serialized

The firmware echoes nothing — replies are bare values with no way to tell which
request they answer. This library therefore keeps **at most one query in
flight**, internally queued. Concurrent callers are safe:

```ts
// Safe. Runs sequentially under the hood.
const [volts, amps] = await Promise.all([
  psu.measureVoltage(),
  psu.measureCurrent(),
]);
```

For a sequence that must not be interleaved by another caller, use a
transaction:

```ts
await psu.socket.transaction(async (ch) => {
  await ch.write('SOURCE:VOLTAGE 12');
  return ch.query('SOURCE:VOLTAGE?');
});
```

### Reading V and I together

Two separate `await`s are a round trip apart, and because serialization is
per-request another caller's query can land between them. On a transient load —
inrush, a switching supply, the instant the output is enabled — multiplying
those two readings gives a power figure that was never simultaneously true.

`measure()` solves this. By default it reads everything from a single UDP
datagram sampled at one instant (see below); where UDP is unavailable it falls
back to taking both queries inside one SCPI transaction, so nothing interleaves
and the gap is one round trip.

```ts
const { voltage, current, power, timestamp } = await psu.measure();

const reading = await psu.measure({ mode: true });
if (reading.mode === 'CC') console.log('current limited');
```

Use this for poll loops. `measureVoltage()` / `measureCurrent()` remain for when
you genuinely only need one.

### Measurements use UDP by default

The supply exposes an **undocumented UDP service on port 9221** that returns
output state, measured voltage and measured current in a **single datagram**,
all sampled at one instant. `measure()` uses it by default, because over SCPI
the same reading costs two or three round trips that each sample a different
moment.

It is also the one place where UDP's lack of ordering guarantees costs nothing:
the request carries no information — the device ignores the payload entirely —
so every reply is a complete, self-contained snapshot. A reordered or duplicated
datagram is harmless, because there is nothing to correlate it against.

```ts
const psu = await connect({ host });
psu.usingUdp; // true when the device answered the probe

const { voltage, current, power, mode } = await psu.measure({ mode: true });
// mode comes free over UDP; on the SCPI path it costs an extra round trip
```

Availability is probed once at connect. If the device does not answer — a
different model, older firmware, a firewall in the way — it falls back to SCPI
silently and `usingUdp` reports `false`. A datagram lost mid-session also falls
back for that call. Opt out entirely with:

```ts
const psu = await connect({ host, udp: false });
```

**This channel is monitor-only.** It cannot set a voltage, enable an output or
read the error queue. All control goes over SCPI regardless.

**There is no streaming mode** — it is strictly request/response. One datagram
in, exactly one out; silence when you send nothing. It does not rate-limit, so
poll as fast as you like: ten back-to-back requests get ten replies, and
sustained poll-on-reply measures ~21 Hz on a typical LAN, which is round-trip
time rather than a device limit. (The vendor's own applet polls at 2 Hz.)

Documented nowhere by B&K — the frame layout was established by probing an
XLN6024 on firmware 1.20. See `plans/xln-modernization.md`.

### Setters are verified by default

Set commands produce no reply, and this firmware has **no `*OPC?`** — so a
rejected setpoint would otherwise fail silently. Every write is therefore
followed by `SYSTEM:ERROR?`, and a non-zero code throws `XLNDeviceError`:

```ts
await psu.setVoltage(12); // resolves only if the device accepted it
```

That costs a round trip. Disable it if you need the throughput and are checking
errors yourself:

```ts
const psu = await connect({ host, autoCheckErrors: false });
```

### Reconnecting

Off by default. When enabled, commands issued while disconnected reject
immediately rather than being buffered — replaying setpoints into a supply that
may have power-cycled isn't something a driver should do implicitly.

```ts
const psu = await connect({
  host,
  autoReconnect: { minDelay: 500, maxDelay: 30_000 },
});

psu.socket.on('disconnected', (error) => console.warn('lost link', error));
psu.socket.on('connected', () => {
  // Re-apply whatever the supply needs to be in the right state.
});
```

### Cancellation

```ts
const psu = await connect({ host, signal: AbortSignal.timeout(5000) });

// Per-command, on the raw escape hatches:
await psu.query('MEASURE:VOLTAGE?', { signal, timeout: 250 });
```

## API

Every method is async. Getters return `number` or `boolean`, never strings.

**Identity and reset** — `identity`, `spec`, `getIdentity()`, `reset()`,
`clearStatus()`, `saveToMemory(slot)`, `recallFromMemory(slot)`, `abort()`

**Measurement** — `measure()`, `usingUdp`, `measureVoltage()`,
`measureCurrent()`, `measurePower()`, `fetchVoltage()`, `fetchCurrent()`

**Setpoints** — `getVoltage()`/`setVoltage(v)`, `getCurrent()`/`setCurrent(a)`

**Output** — `getOutput()`/`setOutput(on)`, `getRegulationMode()`,
`getVoltageLimit()`/`setVoltageLimit(v)`,
`getCurrentLimit()`/`setCurrentLimit(a)`,
`getVoltageSlewRate()`/`setVoltageSlewRate(vPerMs)`,
`getCurrentSlewRate()`/`setCurrentSlewRate(aPerMs)`, `clearProtection()`

**Protection** — `getProtectionTripped()`, and enable/level pairs for
over-voltage (`getOverVoltageProtection`, `getOverVoltageLevel`, …),
over-current, and over-power, plus `getCvToCcProtection()` and
`getCcToCvProtection()`

**System** — `getError()`, `getErrors()`, `getSerialNumber()`, `getBeep()`,
`getKeyLock()`, `getBacklight()`, `getAux5V()`, `getStatus()`,
`getPowerOnMode()`/`setPowerOnMode(mode)` and the matching power-on
voltage/current/output accessors, `recallFactoryDefaults()`

**Memory presets** — `getMemorySlot()`/`selectMemorySlot(n)`,
`getMemoryVoltage()`/`setMemoryVoltage(v)`,
`getMemoryCurrent()`/`setMemoryCurrent(a)`, `saveMemory()`

**Raw access** — `command(cmd, opts?)` for a write, `query(cmd, opts?)` for a
query, and `psu.socket` for the underlying `ScpiSocket`.

> ⚠️ **Sending a command this firmware does not recognize can take the
> instrument off the network until it is power-cycled.** Observed twice on an
> XLN6024 (fw 1.20): after a few unsupported forms — `OUTP?`, `OUT?`, a `;`
> compound, `*OPC?`, `SOURCE:VOLTAGE? MAX` — it stopped accepting TCP on ports
> 80, 5024 and 5025 while still answering ping, and did not recover on its own.
> `autoCheckErrors` cannot protect you either: an unsupported command returns
> silence, so the follow-up `SYSTEM:ERROR?` times out rather than reporting an
> error. Prefer the typed methods, whose command forms are all verified against
> real hardware.

### `getStatus()`

Decodes the legacy `STATUS?` bitfield. This is the **only** way to read latched
over-temperature and AC-low faults — neither has a SCPI query.

```ts
const status = await psu.getStatus();
if (status.occurred.overTemperature) console.error('Supply overheated');
if (status.occurred.acLow) console.error('Mains sagged');
```

### Errors

All derive from `XLNError`.

| Class                | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `XLNConnectionError` | Connect failed, link dropped, or used after close   |
| `XLNTimeoutError`    | No reply within the timeout                         |
| `XLNProtocolError`   | Reply could not be parsed — carries the raw text    |
| `XLNDeviceError`     | Device reported an error via `SYSTEM:ERROR?`        |
| `XLNRangeError`      | Value out of range for this model; nothing was sent |

## Testing your own code

The mock device the library tests against is published as `xln/testing`, so you
can drive your code without hardware:

```ts
import { MockDevice } from 'xln/testing';
import { connect } from 'xln';

const device = await MockDevice.start();
const psu = await connect({ host: '127.0.0.1', port: device.port });

device.voltage = 12;
device.output = true;
console.log(await psu.measure());

await psu.close();
await device.stop();
```

It models the behaviours that actually matter — set commands reply with
nothing, unrecognized commands queue a command error — and can reproduce the
framing pathologies the transport has to survive: fragmented replies, NUL
padding, alternate terminators, coalesced replies, and late replies that arrive
after their request has already timed out.

```ts
// A reply that arrives 300 ms late, after a 60 ms timeout has fired:
await MockDevice.start({ replyDelay: (n) => (n === 1 ? 300 : 0) });
```

## Testing against real hardware

```bash
bun run smoke 192.168.1.50                  # read-only
bun run smoke 192.168.1.50 --allow-output   # briefly drives the output
bun run probe 192.168.1.50                  # protocol probe, read-only
```

`probe` resolves the response encodings the B&K manual leaves undocumented and
prints a report worth attaching to an issue.

## Migrating from 0.6.x

The 0.6.x API had a real defect: `send()` armed a `once('data')` listener for
every command — **including set commands, which the device never answers**. That
listener then consumed the _next_ query's response, permanently shifting every
subsequent reading by one. It only worked because callers happened to serialize
themselves.

```ts
// 0.6.x
import { tcpXLN } from 'xln';
const conn = new tcpXLN({ host }, () => {
  conn.setSourceVoltage(12, () => {
    conn.setOutput(true, () => {
      conn.getMeasuredCurrent((current) => {
        console.log(parseFloat(current) > 0 ? 'Load' : 'No load');
        conn.end();
      });
    });
  });
});

// 1.0.0
import { connect } from 'xln';
await using psu = await connect({ host });
await psu.setVoltage(12);
await psu.setOutput(true);
console.log((await psu.measureCurrent()) > 0 ? 'Load' : 'No load');
```

| 0.6.x                          | 1.0.0                        | Note                         |
| ------------------------------ | ---------------------------- | ---------------------------- |
| `new tcpXLN(opts, cb)`         | `await connect(opts)`        |                              |
| `conn.end()`                   | `psu.close()`                | or `await using`             |
| `getIDN`                       | `identity` / `getIdentity()` | parsed into fields           |
| `getSourceVoltage`/`set…`      | `getVoltage`/`setVoltage`    | returns `number`             |
| `getSourceCurrent`/`set…`      | `getCurrent`/`setCurrent`    | returns `number`             |
| `getMeasuredVoltage`           | `measureVoltage()`           | returns `number`             |
| `getMeasuredCurrent`           | `measureCurrent()`           | returns `number`             |
| `getFetchVoltage`              | `fetchVoltage()`             |                              |
| `getOutput`/`setOutput`        | same                         | returns `boolean`            |
| **`getOutputState`**           | **`getRegulationMode()`**    | **see below**                |
| `getOutputVoltageLimit`/`set…` | `getVoltageLimit`/`set…`     |                              |
| `getOutputVoltageSlewRate`     | `getVoltageSlewRate()`       | **V/ms, not V/s**            |
| `resetLatchedProtection`       | `clearProtection()`          | now actually awaits          |
| `getSourceOverVoltageState`    | `getOverVoltageProtection()` |                              |
| `getSourceOverVoltageLevel`    | `getOverVoltageLevel()`      |                              |
| `getBeep`/`setBeep`            | same                         | returns `boolean`            |
| `getError`                     | `getError()`                 | parsed, `null` when no error |
| `udpXLN`                       | **removed**                  | **see below**                |

Three changes deserve attention:

1. **`getOutputState()` did not do what its name says.** It queried
   `OUTPUT:STATE?`, which reports the **CV/CC regulation mode**, not on/off. If
   you used it as an on/off check, you want `getOutput()` now.
2. **Slew rates are V/ms and A/ms.** If you passed a V/s figure it was ~1000×
   off; the library now rejects it with `XLNRangeError` instead of forwarding it.
3. **`udpXLN` is replaced by `UdpStatusChannel`**, and `measure()` uses it
   automatically. UDP 9221 turned out to be real — it is the transport behind
   the web UI's Java status display. It is **monitor-only** and **not**
   discovery (it ignores broadcast), so there is still no vendor-supported way
   to find a supply; configure the host explicitly. The old class was shaped
   like a command interface, which it never was, and its `parseUDPMessage` left
   the fixed-width frame unparsed.

Everything else keeps a recognizable name, so porting is mechanical.

## Contributing

```bash
bun install
bun run check   # format, lint, typecheck, test
bun run build
```

Dependencies are managed with Bun. The library targets Node, and CI runs the
suite on Node 20.19, 22 and 24.

Tests run against the mock device in `src/testing/` and need no hardware. Some
tests load the built `dist/` through both ESM and CommonJS, so run
`bun run build` before `bun run test` if you're changing packaging.

Protocol decisions and their sources are documented in
[`plans/xln-modernization.md`](plans/xln-modernization.md).

### Releasing

Releases go through GitHub Actions, never a local `npm publish` — that is what
gets provenance attestation and a reproducible build from a clean checkout.
Tag the commit and push:

```bash
git tag v1.2.3
git push origin master --tags
```

Prerelease versions publish to the `next` dist-tag automatically; plain versions
go to `latest`. `prepublishOnly` refuses to run outside CI, so an accidental
local publish fails rather than shipping.

Publishing uses npm **trusted publishing** (OIDC) — there is no `NPM_TOKEN` and
no secret anywhere in the repo. npm exchanges the workflow's short-lived OIDC
token for publish credentials, which also means provenance is generated
automatically.

One-time setup on npmjs.com, under the package's _Settings → Trusted publisher_:
select GitHub Actions, organization `cinderblock`, repository `XLN`, workflow
filename **`release.yml`**. Leave the environment field blank unless you also
add a matching `environment:` to the job — the two must agree.

⚠️ Because the trust is bound to the workflow _filename_, renaming
`release.yml` breaks publishing until the npm setting is updated to match.

## License

ISC © Cameron Tacklind
