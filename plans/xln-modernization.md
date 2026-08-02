# XLN Modernization

Bringing the `xln` npm package (last touched November 2015) up to current standards.

## Goal

`xln` is a remote-control library for B&K Precision XLN-series programmable DC power
supplies, speaking SCPI over TCP. It is published on npm as `xln`, currently at
`0.6.4`, maintained by `cinderblock`.

The 2015 code is ES2015 modules compiled by gulp 3 + `babel-preset-es2015` — a
toolchain that does not run on any supported Node version. The library API is
callback-based and has a protocol-level defect that makes it unreliable for anything
beyond one-command-at-a-time use.

Target: a TypeScript, promise-based, tested, CI-built `1.0.0` with a correct
transport layer and a command set that matches the actual device manual.

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\XLN`, branch `master`, remote
  `github.com/cinderblock/XLN`
- Node v24.18.0, npm 11.16.0, bun 1.3.0 available locally
- Tooling versions current as of 2026-07-31: TypeScript 7.0.2, tsdown 0.22.14,
  vitest 4.1.10, eslint 10.8.0, prettier 3.9.6, `@types/node` 26.1.2
- npm published versions: 0.0.1 → 0.6.4 (17 releases), all from Nov 2015
- **Hardware is available** — Cameron can plug in a real XLN unit. This matters; see
  "Open questions" below, several of which are only answerable on the bench.

## Decisions already made (don't re-ask)

1. **Promise/async rewrite, breaking, → 1.0.0.** No callback shim. Method names stay
   recognizable so porting from 0.6.x is mechanical, and the README carries a
   migration table.
2. **Full modern tooling.** TypeScript, dual ESM+CJS output, vitest, eslint flat
   config + prettier, GitHub Actions for test matrix and for publishing with
   provenance.
3. **Mock device for CI, plus real-hardware scripts.** Tests must pass with no
   hardware attached; a probe script and a smoke script exist for the real unit.
4. **Publish `1.0.0-alpha.1` to the `next` dist-tag** once green. Explicitly _not_
   `latest` — 0.6.4 stays as `latest` so `npm i xln` does not break the handful of
   existing users until the alpha has been exercised on hardware.
5. **Releases go through GitHub Actions, exclusively. Never `npm publish` from a
   CLI.** CI publishing gives provenance attestation, a reproducible build from a
   clean checkout, and an auditable record tied to a commit; a local publish has
   none of those and can ship a dirty tree or a stale `dist/`. It also keeps npm
   credentials in repo secrets rather than on a workstation. Enforced by
   `scripts/guard-publish.ts`, wired to `prepublishOnly`, which hard-fails when
   `CI` is unset.

## Release process

1. Bump the version in `package.json` and commit.
2. `git tag v<version> && git push origin master --tags`.
3. `.github/workflows/release.yml` runs the full check suite, then
   `npm publish --provenance`. It picks the dist-tag automatically: any
   prerelease version (`1.0.0-alpha.1`) goes to `next`, a plain version goes to
   `latest`. `workflow_dispatch` allows overriding the tag by hand.

One-time repo setup still required:

- A GitHub **environment named `npm`** (the release job declares
  `environment: npm`; the job fails without it).
- An **`NPM_TOKEN`** secret in that environment — an npm automation token with
  publish rights on `xln`.
- The workflow already requests `id-token: write`, which provenance needs.

## Protocol research findings

Full sourced report was produced 2026-07-31 from three revisions of the official B&K
manual. Primary source: [XLN Series manual, © 2009-2018](https://bkpmedia.s3.us-west-1.amazonaws.com/downloads/manuals/en-us/XLN_Series_manual.pdf)
(203 pp; it is a combined document — PDF pp. 1-97 cover XLN3640/6024/8018/10014,
PDF pp. 98-203 cover XLN15010/30052/60026).

### Findings that change the design

- **UDP / port 9221 does not exist on this device.** Zero occurrences of "UDP",
  "9221", "broadcast", or "discovery" across the 2010, 2013, and 2018 manuals or the
  datasheet. The manuals document exactly three LAN modes: web server (port 80,
  Java), Telnet (5024), and raw sockets (5025). Port 9221 is an **Aim-TTi**
  convention and it is TCP there, not UDP.
  Corroborating evidence from our own history: UDP was the entire initial commit
  (`7b9f5d4`) with an empty `parseMessage` stub that just returned the string
  unchanged; TCP landed the next day (`b2a4ed8`) and every commit after that touched
  only the TCP class. **The `udpXLN` class almost certainly never worked. Drop it.**
  There is no vendor-supported discovery mechanism at all — the only option would be
  sweeping the subnet with TCP connects + `*IDN?`, which is out of scope.

- **Set commands return nothing.** `*CLS`, `*RST`, `*SAV`, `*RCL`, `ABOR`,
  `OUTP:PROT:CLE` and every setter produce no response. The 0.6.x API accepts a
  callback on all of these, and that callback can never fire — worse, the pending
  `once('data')` listener steals the _next_ query's response. This is the root of the
  desync. The new API must model set-vs-query as distinct operations.

- **`:OUT?` is undocumented and revision-dependent.** The 2013 manual documents the
  Output subsystem short form as `OUT`; the 2018 manual changed it to `OUTP`. `OUT`
  separately exists as a _legacy, set-only, non-SCPI_ command (`OUT 1`) with no query
  form. Use the **long form** (`OUTPUT?`, `OUTPUT:LIMIT:VOLTAGE?`, …) which is
  documented identically in all three revisions.

- **`OUTPut?` and `OUTPut:STATe?` are different things.** `OUTPut?` returns output
  on/off. `OUTPut:STATe?` returns the _regulation mode_, CV or CC. The 0.6.x
  `getOutputState()` is misleadingly named for what it actually queries.

- **Slew rate is V/ms and A/ms**, not per second. Front panel confirms:
  `VOLT SLEW RATE = 3.0000 V/mS`. Per-model ranges are tabulated in
  `src/models.ts`.

- **Terminator is `\r\n`.** "All commands are terminated with `<CR>` and `<LF>`
  characters" — stated in every manual revision. 0.6.x sends `\n` only. It evidently
  worked (these parsers are usually tolerant) but `\r\n` is the documented contract.

- **No leading colon in any documented example.** Every example is `MEAS:VOLT?`,
  `SOUR:VOLT 30`, `SYS:ERR?` — never `:MEAS:VOLT?`. A leading colon is legal SCPI but
  this is a hand-rolled parser and B&K never documents it. Send without.

- **`SYS:BEEP`, not `SYSTEM:BEEPER`.** The node is `BEEP`.

- **`*OPC?`, `*ESR?`, `*STB?`, `*WAI`, `*TST?` and the entire `STATus:` subsystem do
  not exist here.** Only five common commands are documented: `*CLS`, `*IDN?`,
  `*RCL`, `*RST`, `*SAV`. So there is **no** standard way to synchronize after a
  write. Error detection has to go through `SYS:ERR?`.

- **One command per TCP write.** Commit `93f9bdc` (2015-11-07, "Make sure each
  `.write()` is sent on its own") added `setNoDelay()` — strong empirical hint the
  firmware parser mishandles coalesced segments. No manual example anywhere uses `;`
  compound commands. Keep `setNoDelay()`, never batch.

- **Assume a single TCP connection.** Undocumented, but a comparable design (TTi)
  documents exactly 2 sockets. Serialize all access inside the library.

- **Average command response time ≤ 50 ms** (datasheet). Read timeouts should be well
  above this; do not poll faster.

- **Ethernet only exists on `-GL` suffix models**, and the interface must be selected
  manually on the front panel (System Setting → Remote Control → Ethernet, IP =
  Static). DHCP is not offered. Worth a README note — it will be the first thing a
  user gets wrong.

- **`SYS:REM` selects the active physical interface** (USB/GPIB/ETHERNET), _not_
  IEEE-488 remote/local lockout. Sending `SYS:REM USB` over LAN cuts your own
  connection. **Do not expose this without a loud warning.**

### Things the old library missed that are worth adding

- `PROTection` subsystem: `PROT?`, `PROT:OVP`, `PROT:OCP`, **`PROT:OPP`
  (over-power — entirely absent from 0.6.x)**, `PROT:CVCC`, `PROT:CCCV`, each with
  `:LEVel`
- `OUTPUT:STATE?` for CV/CC regulation-mode detection
- Legacy `STATUS?` three-byte bitfield — the only way to read latched fault flags
  including over-temperature and AC-low, which have no SCPI query
- `SYSTem:KEY:LOCK` — front panel lock
- `SYSTem:POWer:TYPE` / `:VOLTage` / `:CURRent` / `:STATe` — power-on state
- `SYSTem:SERies?`, `SYSTem:LCD:BL`, `SYSTem:E5V` (aux 5 V, high-current models)
- `MEMory` subsystem (distinct from `*SAV`/`*RCL`)

Deferred to a later release (documented but response encodings unverified, and large
enough to be their own feature): `PROGram` list/sequence programming, `TIMER`,
`PS:MODE`/`PS:TYPE` parallel-series.

## Architecture

```
src/
  index.ts       public exports
  transport.ts   ScpiSocket — connection, framing, serialized queue, timeouts
  xln.ts         XLN class — typed SCPI command methods
  models.ts      per-model limit table + *IDN? parsing
  parse.ts       response value parsing (number, boolean, error code, STATUS?)
  errors.ts      XLNError hierarchy
test/
  mock-device.ts fake XLN speaking SCPI over TCP
  *.test.ts
scripts/
  probe.ts       resolves the UNVERIFIED protocol questions against real hardware
  smoke.ts       end-to-end check against real hardware
```

**Transport design.** A promise chain serializes every command so two callers can
never interleave. Received bytes accumulate in a buffer; NULs are stripped, the
buffer is split on `\n`, and each line is `\r`-trimmed. `write()` sends and resolves
without expecting a reply. `query()` sends and resolves on the next complete line.
A line arriving while no query is pending is a protocol anomaly — emit it as an
`unsolicited` event and discard, rather than letting it desync the stream.

**Error checking.** Because writes are silent and there is no `*OPC?`, a failed
`setCurrent()` is invisible by default. This is a 1440 W power supply, so the default
is **`autoCheckErrors: true`** — each write is followed by `SYS:ERR?` and a non-zero
code throws. Costs a round trip; users who need throughput set it false.

## Progress log

- [x] Read the 2015 source, git history, npm registry state
- [x] Commission and receive protocol research report
- [x] Decisions confirmed with Cameron (async rewrite / hardware available / full
      tooling / alpha to `next` tag)
- [x] Write this plan
- [x] Scaffold toolchain — package.json, tsconfig, tsdown, eslint, prettier; deleted
      gulpfile.js and .npmignore
- [x] Implement `transport.ts` — queue, framing, timeouts, transactions,
      AbortSignal, opt-in auto-reconnect
- [x] Implement `models.ts`, `parse.ts`, `errors.ts`, `xln.ts`
- [x] Mock device + vitest suite — 93 tests, including ones that drive the built
      `dist/` through both ESM and CommonJS
- [x] `scripts/probe.ts` + `scripts/smoke.ts`, both exercised against the mock
- [x] README rewrite + migration table, CHANGELOG
- [x] GitHub Actions: test matrix + release with provenance
- [x] Read and answer `consumer-requests-xln-control.md` (see
      `plans/reply-to-xln-control.md`)
- [x] Packaging validated — publint + attw green across node10, node16 CJS,
      node16 ESM and bundler resolution; `npm publish --dry-run --tag next` clean
- [ ] **Run probe against real hardware** and fold answers into tests
- [ ] **Release `1.0.0-alpha.1` to `next`** — via GitHub Actions only (see
      "Release process" below). Needs the repo pushed, an `npm` GitHub
      environment, and an `NPM_TOKEN` secret. **Must land on `next`, never
      `latest`** — 0.6.4 stays `latest` until the alpha has run on hardware.

## Round 2: consumer feedback and follow-up decisions

The XLN-Control agent reviewed `1.0.0-alpha.1` (see
`plans/consumer-requests-xln-control-round-2.md`) and found a real bug.

- **`measurePower()` was incoherent.** Two separate `await`s meant
  `V(t) x I(t + one round trip)`, and since serialization is per-request another
  caller's query could land between them and widen the gap arbitrarily. Fixed by
  adding `measure()`, which takes V, I and an optional CV/CC mode inside one
  `transaction()`. `measurePower()` now delegates to it.
- **Coalesced replies to _different_ requests cannot happen against this
  client.** Trying to test it via the mock deadlocks: strict one-in-flight means
  request 2 is not sent until reply 1 arrives, so a well-behaved device has
  nothing to batch. The framing is still tested for it, using a raw server that
  volunteers both replies in one segment. This retroactively validates choosing
  strict serialization over a pipelined FIFO.
- **`xln/testing`** now exports the mock so the consumer can delete their own
  simulator. Needs a `testing/package.json` redirect stub shipped in `files` —
  legacy node10 resolution cannot see subpath exports, and attw flags it
  otherwise.
- **Hardware availability was contradictory.** The consumer agent was told no
  supply was reachable; Cameron confirmed to me directly (twice) that one **can
  be plugged in**. The probe remains a real near-term step.
- **Switched to Bun** (`bun.lock`) to match `react-smoothie`, `CloudWarden`,
  `battery-controller`, `Gate Manager` and XLN-Control. CI installs with Bun but
  runs the suite on Node across the 20.19/22/24 matrix, and the release job
  still publishes with npm because provenance is an npm feature.

## HARDWARE PROBE RESULTS (2026-07-31, XLN6024 at 10.255.14.231)

Real unit: `BK PRECISION,XLN6024,276G11128,1.20,0` — firmware 1.20.

**Every one of the previously-UNVERIFIED questions is now answered.**

| Question                | Answer                                                                                              | Impact                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Response terminator     | **bare `LF`**, never CRLF                                                                           | We send CRLF (per manual) and parse tolerantly — fine         |
| NUL padding             | **Real.** One `�` _after_ the LF, on some replies but not all (`*IDN?` none, `SOURCE:VOLTAGE?` one) | Not fixed-width padding. Framing already strips it            |
| `SYSTEM:ERROR?` format  | **bare `0`** — not `0,"No error"`                                                                   | `parseDeviceError` already accepts it                         |
| Boolean encoding        | **`OFF`/`ON`** — not `0`/`1`                                                                        | `parseBoolean` already accepts it. **Mock default was wrong** |
| `OUTPUT:STATE?`         | Returns **`OFF`** when output is off — _not_ CV/CC                                                  | See below. Would have thrown before the open-union change     |
| `STATUS?`               | **6-char contiguous hex** (`000000`)                                                                | `parseStatus` already handles hex                             |
| Leading colon           | **Accepted** (`:SOURCE:VOLTAGE?` works)                                                             | We don't send one; harmless either way                        |
| `SOUR:VOLT?` short form | **Accepted**                                                                                        | —                                                             |
| `OUTP?` short form      | **REJECTED (silence)**                                                                              | Confirms the long form `OUTPUT?` was the right call           |
| `;` compound commands   | **REJECTED (silence)**                                                                              | Confirms never batching                                       |
| `*OPC?`                 | **Does not exist (silence)**                                                                        | Confirms `SYSTEM:ERROR?` is the only write sync               |
| `SOURCE:VOLTAGE? MAX`   | **Not supported (silence)**                                                                         | Confirms the per-model limit table is necessary               |
| Second TCP session      | **Reset, then the device WEDGED**                                                                   | See the warning below                                         |
| Slew rate               | `OUTPUT:SR:VOLTAGE?` = `3.0000` = the XLN6024 max in **V/ms**                                       | Confirms V/ms, not V/s                                        |

### The open union on `RegulationMode` was load-bearing

`OUTPUT:STATE?` returns **`OFF`** while the output is disabled — not `CV`, not `CC`.
My original implementation threw `XLNProtocolError` on anything but CV/CC. The
XLN-Control agent argued it should degrade instead; I changed it on their
reasoning alone. **That change is the only reason `getRegulationMode()` does not
throw against real hardware in its most common state** (output off). Add `'OFF'`
to the documented union members.

### UDP: probed against real hardware, silent everywhere

Ran `bun run probe:udp 10.255.14.231` (2026-08-02). **Every probe silent:**

- Unicast `*IDN?` to udp/9221, udp/5025, udp/5024 — nothing
- The exact 2015 `udpXLN` wire format (96-byte NUL-padded `*IDN?`) to udp/9221 — nothing
- The 2015 `readStatus()` payload (`MEAS:CURR?`, 96-byte padded) — nothing
- Broadcast `*IDN?` to 255.255.255.255 and every interface's directed broadcast,
  on 9221 and 5025 — nothing

**Caveat, stated honestly:** this run happened while the unit's TCP services were
down (see below), so if the whole remote subsystem was disabled then a UDP server
would have been off too. Re-run on a healthy unit to make it conclusive. An earlier
broadcast-only run on a _healthy_ network was also silent, and three manual
revisions contain zero mentions of UDP — so the conclusion is very likely right,
just not yet airtight.

### Why UDP would not help even if it existed

Worth recording, because it comes up: the response-correlation problem is **not** a
TCP problem. It is that the device's replies carry no identifier — no echo, no
sequence number, no tag. `12.345` arrives and nothing in it says which question it
answers. That is true over any transport.

TCP at least guarantees ordering and delivery. UDP guarantees neither. Combining
"replies carry no identifier" with "replies can arrive out of order or vanish"
makes correlation impossible rather than merely awkward. Switching to UDP would
remove the one property the current design relies on.

The correlation issue is also already solved: strict one-in-flight serialization,
with a test firing five concurrent queries that asserts each caller gets its own
answer.

### DANGER: a second TCP connection can wedge the instrument

Opening a second simultaneous connection to port 5025 caused the device to
`ECONNRESET` the new session — and then **all TCP services died**. Ports 80, 5024
and 5025 all stopped accepting connections while the unit still answered ICMP
ping. It did not recover on its own after 2.5 minutes of polling.

Contributing factor: the probe script crashed on the unhandled `ECONNRESET` and
left its primary socket open, so the device may have been holding a stale session.
Either way the conclusion is the same and it is stronger than "assume
single-session":

**Never open a second connection. Always close cleanly. A crashed client can
leave the instrument unreachable until it is power-cycled.**

**Update (2026-08-02): a power cycle alone did not restore it.** After Cameron
power-cycled, the unit answers ICMP ping but ports 80, 5024 and 5025 all still
refuse. It is not elsewhere on the subnet either (full /24 sweep found nothing).
Most likely the power cycle reset the front-panel remote interface selection away
from Ethernet — the manual requires System Setting -> Remote Control -> Ethernet
to be chosen manually, and with USB or GPIB selected the LAN stack can still hold
an IP (answering ping) without starting the TCP servers. Needs checking at the
front panel.

This belongs in the README as a prominent warning, and it is worth considering
whether the library should actively help — e.g. documenting `close()` in a
`finally`, and the `await using` pattern.

## Findings / gotchas discovered during implementation

- **TypeScript 7.0.2 is `latest` but unusable here.** `typescript-eslint` 8.65 caps
  its peer range at `<6.1.0`, so type-aware linting breaks on TS 7. Pinned to
  TypeScript 5.9.3. Revisit when typescript-eslint ships TS 7 support — the emitted
  output is identical either way.
- **`*CLS` ordering was a real race.** Sending it _after_ `*IDN?` in `connect()`
  meant the write could still be in flight when the caller issued their first
  command, and would then wipe the error that command produced. Writes resolve when
  bytes reach the OS, not when the device has acted. Fixed by ordering `*CLS` before
  the `*IDN?` query, so the query's round trip proves it landed. Regression test in
  `test/xln.test.ts`.
- **`await using` is only native from Node 24.** Not Node 20 or 22. The tests use it
  and CI runs down to 20.19, so `vitest.config.ts` sets `oxc: { target: 'node20' }`
  to downlevel. Note vitest 4 uses **oxc, not esbuild** — setting `esbuild.target`
  is silently ignored with a warning. The shipped `dist/` is unaffected (the only
  `await using` occurrences in it are inside JSDoc comments; verified).
- **Node's `--experimental-strip-types` does not remap `.js` → `.ts` in imports**, so
  it cannot run `scripts/*.ts` against `src/`. Using `tsx` instead.
- **tsdown emits `.mjs`/`.cjs`**, not `.js`. The exports map has to match; `publint`
  and `attw` now run on every build and catch this.
- Do not assert TCP segment boundaries in tests. Two `socket.write()` calls in the
  same tick can land in one segment regardless of `setNoDelay`; that is the OS's
  business. Assert the byte stream instead.

## Verification performed

- 93 tests green: framing (fragmented, NUL-padded, CR/LF/CRLF), queue serialization
  under concurrency, timeouts and late-reply resync, abort, reconnect with backoff,
  range validation, error checking, and both module formats of the built bundle.
- `bun run probe` and `bun run smoke` (including `--allow-output`) both exercised
  end to end against the mock device.
- `bun link` verified from a scratch project outside the repo, driving a real socket
  under both `node` and `bun`.
- `publint` and `attw` clean; `npm pack` ships exactly `dist/`, README, LICENSE,
  package.json.
- **Not verified locally: the Node 20.19 and 22 CI legs.** Only Node 24 is installed
  on this machine. CI is the proof; if the `await using` downlevel is wrong, those
  legs fail with a syntax error in the test files.

## Open questions for the user

These are the items the manuals do not answer. All are ~20 minutes on the bench with
`scripts/probe.ts`, and the answers should become test fixtures.

1. **What terminator does the device send on responses?** Manual never says. We parse
   tolerantly (`\n` split, `\r` trim) so this is low-risk either way.
2. **Are responses really NUL-padded?** Commit `041cd13` ("Trim extra unwanted
   characters from the responses") is first-hand evidence from a real device, but the
   cause is undocumented. Is it fixed-width padding?
3. **Exact `SYS:ERR?` wire format.** Standard SCPI is `0,"No error"`, but the web GUI
   docs describe the status field as just `0`, and the error table lists codes as
   `-000`, `-001`, … We parse all three shapes defensively. **This one gates the
   `autoCheckErrors: true` default** — worth confirming early.
4. **`OUTP:STAT?` encoding** — literal `CV`/`CC` strings, or an integer?
5. **Boolean query encoding** — `0`/`1` or `OFF`/`ON`?
6. **`STATUS?` encoding** — the manual says "three bytes"; hex string, decimal, or
   raw binary?
7. Does the firmware accept a leading colon, and `;` compound commands, and more than
   one simultaneous connection on 5025? (We assume no to all three and design
   accordingly; confirming just tells us how much margin we have.)

**Which XLN model do you have?** It determines the limit table entry the smoke test
range-checks against. `*IDN?` will tell us during the probe run.

Also note the model must be a **`-GL`** variant to have Ethernet at all, and the
front panel must be set to System Setting → Remote Control → Ethernet with a static
IP before anything can connect.

## Things not to do

- **Do not resurrect the UDP class.** It is not a real protocol on this device. If a
  future session sees `udpXLN` referenced in the npm 0.6.4 tarball or old README and
  thinks it was dropped by mistake — it was dropped deliberately, see above.
- **Do not use `:OUT` short forms.** 2013-manual-only. Long form everywhere.
- **Do not expose `SYSTem:REMote` casually.** It switches the active physical
  interface and will disconnect a LAN caller.
- **Do not batch commands** with `;` or coalesce writes. `setNoDelay()` stays.
- **Do not assume `*OPC?` exists** for write synchronization. It does not.
- **Do not publish the alpha to `latest`.** `next` tag only.
- Do not treat slew rate as V/s.
