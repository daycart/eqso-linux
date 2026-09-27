import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("capture summary recognizes release without printing a fake JOIN password", () => {
  const directory = mkdtempSync(join(tmpdir(), "v113-summary-"));
  try {
    const password = "FAKE_TOKEN_NEVER_LOG";
    const field = (value) => Buffer.concat([Buffer.from([value.length]), Buffer.from(value)]);
    const joinPacket = Buffer.concat([
      Buffer.from([0x1a]),
      field("0R-DEMO"), field("PRUEBAS"), field("test"), field(password),
    ]);
    const header = Buffer.from([0x0a, 0x78, 0, 0, 0]);
    const voice = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(198)]);
    const lines = [
      ["1000", "0", "50000", "1", Buffer.concat([header, joinPacket]).toString("hex")],
      ["1001", "0", "50000", String(1 + header.length + joinPacket.length), voice.toString("hex")],
      ["1001.1", "0", "2171", "1", "06"],
      ["1002", "0", "50000", String(1 + header.length + joinPacket.length + voice.length), "0d"],
      ["1002.1", "0", "2171", "2", "08"],
    ];
    const tshark = join(directory, "tshark");
    writeFileSync(tshark, "#!/bin/sh\ncat <<'DATA'\n" +
      lines.map((row) => row.join("\t")).join("\n") + "\nDATA\n", { mode: 0o755 });
    const tool = fileURLToPath(new URL("../tools/summarize-v113-capture.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [tool, "placeholder.pcapng", "2171"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Client release-0d/);
    assert.match(result.stdout, /PTT owner marker/);
    assert.doesNotMatch(result.stdout, new RegExp(password));
    assert.doesNotMatch(result.stdout.toLowerCase(), new RegExp(Buffer.from(password).toString("hex")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});