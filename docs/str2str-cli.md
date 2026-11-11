# `gnss str2str` — receiver → RTCM3 stream server

Design note — not yet built. The encoder it needs (`RtcmBaseEncoder` in
`gnss-js/rtcm3`) is done and validated; this is the plumbing around it.

## Goal

Turn any receiver gnss-js can decode into a live RTCM3 reference station that
rovers connect to over TCP — what RTKLIB's `str2str` does with
`-out tcpsvr://:2101#rtcm3`:

```
gnss str2str --in serial:///dev/ttyACM0:115200 \
             --out tcpsvr://:2101 \
             --msm 7 --station 1234 \
             --arp 3924698.0761,301124.6372,5001904.9128 --height 0.0 \
             --antenna "TRM59800.00     SCIS"
```

## Why a Node command, not gnsscalc

A stream source must stay up for hours and accept inbound connections. A
browser tab can do neither (it cannot listen on a port), and Cloudflare Workers
accept only HTTP on 80/443 — raw inbound TCP needs Spectrum (enterprise). Node
does both trivially, runs on a field laptop, and runs 24/7 on a NAS next to a
receiver (the DS920+ already hosts Docker services).

gnsscalc may later _show_ what a receiver's RTCM3 would contain (message mix,
bandwidth per MSM level), but it is not the stream server.

## Shape

```
input (bytes) → format detect → decoder (epochs + ephemerides)
              → RtcmBaseEncoder.encodeEpoch / addEphemerides
              → framed RTCM3 → every connected client
```

### Inputs (`--in`)

| URL                                 | Notes                                        |
| ----------------------------------- | -------------------------------------------- |
| `serial://<dev>:<baud>`             | `serialport` package (optional dependency)   |
| `tcpcli://host:port`                | receiver's raw TCP port                      |
| `ntrip://user:pass@host:port/mount` | existing `gnss-js/ntrip` client              |
| `file://<path>[::speed]`            | replay a log at real time (×speed) — testing |

Format is detected from frame sync bytes (UBX `B5 62`, SBF `$@`, NovAtel
`AA 44 12`, Trimble `02 … 03`, BINEX), as gnsscalc's `receiver-decode.ts` does
— that logic should move into gnss-js so both share it.

### Outputs (`--out`, repeatable)

| URL                              | Notes                                                                |
| -------------------------------- | -------------------------------------------------------------------- |
| `tcpsvr://:port`                 | the main one; every client gets the stream from its next message on  |
| `ntrips://:pass@host:port/mount` | push to a caster (NTRIP v1 `SOURCE`, v2 `POST`), later               |
| `file://<path>`                  | log the RTCM3 (with optional hourly rotation like str2str's `::S=1`) |

### Options

- `--msm 1..7` (default 7), `--station <0–4095>`.
- `--arp x,y,z` + `--height`, or `--arp auto` → the receiver's own averaged
  SPP/PVT position after N minutes (print it; a base should be surveyed).
- `--antenna`, `--receiver` → 1033.
- `--station-interval` (default 10 s), `--eph-interval` (default 60 s — a TCP
  server has clients joining mid-stream, so re-sending ephemerides matters
  here, unlike files).
- `--systems GREC…` to restrict constellations (bandwidth on radio links).

## Streaming decode — the one real gap

The receiver decoders are batch (`parseUbxRawx(bytes)`); gnsscalc's live path
re-decodes a trailing window and dedups by epoch time (`tcp-ingest.ts`), and
had to learn to hold back the newest epoch because Trimble splits epochs across
messages. The CLI needs the same, so the clean step is a streaming receiver
decoder in gnss-js (`ReceiverStream.push(chunk) → { epochs, ephemerides }`),
built once and used by both gnsscalc and the CLI.

## Behaviour to get right

- **Late joiners.** On connect, send 1005/1006 + 1033 + all current ephemerides
  immediately, then the live stream from the next message boundary — never a
  half frame.
- **Slow clients.** Bounded per-client buffer; drop the client, not the stream.
- **Receiver restarts.** Time going backwards resets the encoder's lock arcs
  (`MsmEncoder` already does this per system).
- **Clock.** MSM epochs are the receiver's; nothing is re-timed.

## Validation plan

1. Replay `test-fixtures/oem719_rtk_base.gps` through `tcpsvr`, connect
   RTKLIB `str2str -in tcpcli://localhost:2101 -out file://x.rtcm3`, compare
   with `receiverToRtcm3` output byte for byte.
2. RTKLIB `rtkrcv` (or an F9P rover over its serial port) using the stream as
   base against a known baseline — DLF100/DLFV03 at TU Delft is a zero baseline.
3. Kill and reconnect clients mid-stream; restart the input.

## Out of scope

Hosting a caster (that is the Networks platform), relaying RTCM from one
caster to another (str2str does that already), and RTCM2.
