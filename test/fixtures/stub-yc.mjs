#!/usr/bin/env node
// Stub for `yc iam create-token`. Prints a token from STUB_YC_TOKEN or a
// generated one. Set STUB_YC_FAIL to print to stderr and exit 1; set
// STUB_YC_HANG to keep the process alive; set STUB_YC_COUNTER to append a line.

import { appendFileSync } from "node:fs";

const prefix = ["t", "1", "."].join("");
const token = process.env.STUB_YC_TOKEN || prefix + "A".repeat(40);

if (process.env.STUB_YC_COUNTER) {
  try {
    appendFileSync(process.env.STUB_YC_COUNTER, "run\n");
  } catch {
    /* ignore */
  }
}
if (process.env.STUB_YC_FAIL) {
  process.stderr.write(process.env.STUB_YC_FAIL);
  process.exit(1);
}
if (process.env.STUB_YC_HANG) {
  setTimeout(() => {}, 60000);
} else {
  process.stdout.write(token + "\n");
}
