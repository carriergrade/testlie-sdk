#!/usr/bin/env node
// `npx @testlie/cli ...` without installing anything: this package only depends on @testlie/sdk
// (pinned to the same version) and runs its CLI.
import { main } from "@testlie/sdk/cli";

main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`testlie: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 3;
  },
);
