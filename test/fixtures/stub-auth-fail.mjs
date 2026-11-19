#!/usr/bin/env node
// LEGACY_AUTH stub: simulates a failing refresh (e.g. yc unavailable / expired).
// Writes a fake token-looking string to BOTH stdout and stderr, so tests can
// prove the CLI never surfaces it.
import { appendFileSync } from "node:fs";

const counter = process.env.COUNTER_FILE;
if (counter) appendFileSync(counter, "run\n");

const fake = ["t", "1", "."].join("") + "Z".repeat(40);
process.stdout.write(`stdout-secret ${fake}\n`);
process.stderr.write(`refresh failed near ${fake}\n`);
process.exit(1);
