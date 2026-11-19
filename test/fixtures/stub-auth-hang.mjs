#!/usr/bin/env node
// LEGACY_AUTH stub: hangs forever, simulating a refresh that never returns
// (e.g. the browser-fallback hang the real script guards against).
import { appendFileSync } from "node:fs";

const counter = process.env.COUNTER_FILE;
if (counter) appendFileSync(counter, "run\n");
setInterval(() => {}, 1 << 30);
