#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Thin launcher: defer to the TypeScript CLI (run via Node's native type-stripping).
await import(new URL('../src/cli.ts', import.meta.url).href);
