#!/usr/bin/env node
// Local-only analysis of a Wireshark capture. Never prints packet payloads,
// callsigns, addresses, JOIN fields, audio, or tshark's raw output.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [capture, portText, requestedStream] = process.argv.slice(2);
const serverPort = Number(portText);
if (!capture || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
  console.error("Usage: node summarize-v113-capture.mjs <capture.pcapng> <server-port> [tcp-stream]");
  process.exit(2);
}
const tshark = process.platform === "win32" &&
  existsSync("C:\\Program Files\\Wireshark\\tshark.exe")
  ? "C:\\Program Files\\Wireshark\\tshark.exe"
  : "tshark";

const result = spawnSync(tshark, [
  "-r", capture, "-Y", `tcp.port == ${serverPort} && tcp.len > 0`,
  "-T", "fields", "-e", "frame.time_epoch", "-e", "tcp.stream",
  "-e", "tcp.srcport", "-e", "tcp.seq", "-e", "tcp.payload",
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error || result.status !== 0) {
  console.error("Could not read capture. Install Wireshark with tshark and check the file path.");
  process.exit(1);
}

const streams = new Map();
for (const line of result.stdout.split(/\r?\n/)) {
  const [timeText, streamText, sourceText, seqText, hex] = line.split("\t");
  if (!hex || !/^[\da-f:]+$/i.test(hex)) continue;
  const time = Number(timeText);
  const stream = Number(streamText);
  const seq = Number(seqText);
  const source = Number(sourceText);
  if (![time, stream, seq, source].every(Number.isFinite)) continue;
  const bytes = Buffer.from(hex.replaceAll(":", ""), "hex");
  if (!bytes.length) continue;
  const entry = streams.get(stream) ?? { client: [], server: [] };
  (source === serverPort ? entry.server : entry.client).push({ time, seq, bytes });
  streams.set(stream, entry);
}
// Drop tshark's copy of the raw payload as soon as records are parsed.
result.stdout = "";

function reassemble(segments) {
  const ordered = segments.slice().sort((a, b) => a.seq - b.seq || a.time - b.time);
  const chunks = [];
  const times = [];
  let end = ordered[0]?.seq;
  let gap = false;
  for (const segment of ordered) {
    if (segment.seq > end) {
      gap = true;
      break;
    }
    const skip = end - segment.seq;
    if (skip >= segment.bytes.length) continue; // TCP retransmission
    const extra = segment.bytes.subarray(skip);
    chunks.push(extra);
    for (let i = 0; i < extra.length; i++) times.push(segment.time);
    end += extra.length;
  }
  return { bytes: Buffer.concat(chunks), times, gap };
}

function parseClient({ bytes, times, gap }) {
  const handshake = Buffer.from([0x0a, 0x78, 0, 0, 0]);
  const start = bytes.subarray(0, Math.min(bytes.length, 512)).indexOf(handshake);
  if (start < 0) return null;
  const events = [];
  let i = start + 5;
  let joinLength = null;
  let voiceBlocks = 0;
  let idleBytes = 0;
  let unknown = false;
  while (i < bytes.length) {
    const opcode = bytes[i];
    if (opcode === 0x1a) {
      let next = i + 1;
      for (let field = 0; field < 4; field++) {
        if (next >= bytes.length) { unknown = true; break; }
        next += 1 + bytes[next];
      }
      if (unknown || next > bytes.length) { unknown = true; break; }
      joinLength = next - i;
      i = next;
    } else if (opcode === 0x15) {
      if (i + 9 > bytes.length) { unknown = true; break; }
      i += 9;
    } else if (opcode === 0x01) {
      if (i + 199 > bytes.length) { unknown = true; break; }
      events.push({ type: "voice", time: times[i] });
      voiceBlocks++;
      i += 199;
    } else if (opcode === 0x0d || opcode === 0x03) {
      events.push({ type: opcode === 0x0d ? "release-0d" : "release-03", time: times[i] });
      i++;
    } else if (opcode === 0x02 || opcode === 0x0c) {
      if (opcode === 0x02) idleBytes++;
      i++;
    } else {
      // Never print an unknown byte: the stream may be desynchronized and the
      // byte could belong to a credential or a user-supplied message.
      unknown = true;
      break;
    }
  }
  return { startTime: times[start], events, joinLength, voiceBlocks, idleBytes, partial: gap || unknown };
}

function nearbyServerFrames(frames, from, to, reference) {
  const selected = frames.filter(({ time }) => time >= from && time <= to);
  for (const { time, bytes } of selected.slice(0, 16)) {
    const known = bytes.length === 1 && {
      0x06: "PTT owner marker", 0x08: "PTT clear", 0x0c: "keepalive",
    }[bytes[0]];
    console.log(`    ${(time - reference).toFixed(3)}s  server ${bytes.length} bytes${known ? ` (${known})` : ""}`);
  }
  if (selected.length > 16) console.log(`    ... ${selected.length - 16} further server segments in window`);
}

let matched = 0;
for (const [number, entry] of streams) {
  if (requestedStream !== undefined && String(number) !== requestedStream) continue;
  const client = parseClient(reassemble(entry.client));
  if (!client) continue;
  matched++;
  const server = entry.server.sort((a, b) => a.time - b.time);
  const t0 = client.startTime;
  console.log(`Stream ${number}: legacy 1.13; JOIN ${client.joinLength ?? "not found"} bytes; ` +
    `${client.voiceBlocks} voice blocks; ${client.idleBytes} idle bytes`);
  const voices = client.events.filter((e) => e.type === "voice");
  const releases = client.events.filter((e) => e.type.startsWith("release"));
  if (voices.length) {
    const first = voices[0].time;
    const last = voices.at(-1).time;
    console.log(`  Voice: +${(first - t0).toFixed(3)}s to +${(last - t0).toFixed(3)}s`);
    console.log("  Server responses near first voice block (seconds relative to first voice):");
    nearbyServerFrames(server, first - 0.3, first + 0.8, first);
    console.log("  Server responses near last voice block (seconds relative to last voice):");
    nearbyServerFrames(server, last - 0.3, last + 1.5, last);
  }
  for (const event of releases) {
    console.log(`  Client ${event.type}: +${(event.time - t0).toFixed(3)}s`);
  }
  if (!releases.length) console.log("  No client release command in this stream.");
  if (client.partial) console.log("  Warning: incomplete or unrecognized client framing; summary is partial.");
}
if (!matched) {
  console.error("No complete legacy v1.13 handshake found for this port/stream.");
  process.exitCode = 1;
}