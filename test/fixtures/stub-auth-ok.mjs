#!/usr/bin/env node
// LEGACY_AUTH stub: simulates a successful `the legacy refresh helper --refresh`.
// Appends one line to $COUNTER_FILE (if set) so tests can count invocations.
import { appendFileSync } from "node:fs";

const counter = process.env.COUNTER_FILE;
if (counter) appendFileSync(counter, "run\n");
process.exit(0);
