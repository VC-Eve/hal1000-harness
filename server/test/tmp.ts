// Temporary directories that clean themselves up.
//
// Written after the suite's "timing flakiness" turned out not to be timing. The
// tests had left **46,507** `hal1000-*` directories in the system temp folder
// over a week, and a temp folder with fifty thousand entries makes every
// `mkdtemp` and every directory walk slow enough that timer-bounded tests miss
// their deadlines. The failures looked random and load-dependent because they
// were — the load was the tests' own litter, and it grew with every run. One
// run even surfaced `ENOSPC` on a disk with 131 GB free.
//
// Fifteen test files created a directory per test and removed none. The other
// eighteen removed theirs in a hand-written hook, which worked and is exactly
// the kind of invariant that holds until somebody writes the thirty-fourth file
// and forgets. So the cleanup rides on the creation instead: ask for a
// directory here and it is registered for removal at the same moment it exists,
// with no second thing to remember.
//
// Prefixes stay `hal1000-<label>-` so a leftover directory still names the test
// that made it.

import { afterAll, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const perTest: string[] = [];
const perFile: string[] = [];

async function make(label: string, into: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hal1000-${label}-`));
  into.push(dir);
  return dir;
}

async function sweep(dirs: string[]): Promise<void> {
  // `splice` first so a failed removal is not retried forever, and `force` so a
  // test that already deleted its own directory is not a failure. Cleanup must
  // never be the reason a suite goes red — it is bookkeeping, not a subject.
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
}

/**
 * A directory for one test, removed when that test finishes.
 *
 * The default. Call it from `beforeEach` or from inside a test — anything
 * created between one test and the next goes with it.
 */
export async function tmpDir(label: string): Promise<string> {
  return make(label, perTest);
}

/**
 * A directory shared by every test in one file, removed when the file finishes.
 *
 * For the `beforeAll` case only, where a fixture is built once and the tests
 * read it. Using `tmpDir` there would delete the fixture after the first test.
 */
export async function sharedTmpDir(label: string): Promise<string> {
  return make(label, perFile);
}

afterEach(async () => {
  await sweep(perTest);
});

afterAll(async () => {
  await sweep(perFile);
  // Anything a `beforeEach` made without a test running after it.
  await sweep(perTest);
});
