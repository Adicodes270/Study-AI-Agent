#!/usr/bin/env node
export function main() {
  console.log("Hello from study-agent!");
}

// run when invoked directly via the `study-agent` bin
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
