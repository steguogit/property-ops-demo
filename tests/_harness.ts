// Minimal zero-dependency test harness (works under tsx, no framework needed).
// Provides describe/it/expect-ish helpers and a runner that reports pass/fail
// and exits non-zero on failure.

type Fn = () => void | Promise<void>;

interface Case {
  name: string;
  fn: Fn;
  skip?: boolean;
}

const suites: { name: string; cases: Case[] }[] = [];
let current: { name: string; cases: Case[] } | null = null;

export function describe(name: string, fn: () => void) {
  current = { name, cases: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name: string, fn: Fn) {
  if (!current) throw new Error("it() must be inside describe()");
  current.cases.push({ name, fn });
}

export function itSkip(name: string, _fn: Fn) {
  if (!current) throw new Error("it() must be inside describe()");
  current.cases.push({ name, fn: async () => {}, skip: true });
}

export function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export function assertEqual<T>(actual: T, expected: T, msg?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `${msg ?? "values differ"}\n  expected: ${e}\n  actual:   ${a}`
    );
  }
}

export function assertIncludes(arr: unknown[], value: unknown, msg?: string) {
  const has = arr.some((x) => JSON.stringify(x) === JSON.stringify(value));
  if (!has) {
    throw new Error(
      `${msg ?? "array does not include value"}: ${JSON.stringify(
        value
      )} not in ${JSON.stringify(arr)}`
    );
  }
}

export async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of suites) {
    console.log(`\n${s.name}`);
    for (const c of s.cases) {
      if (c.skip) {
        skipped++;
        console.log(`  ○ (skipped) ${c.name}`);
        continue;
      }
      try {
        await c.fn();
        passed++;
        console.log(`  ✓ ${c.name}`);
      } catch (e) {
        failed++;
        console.log(`  ✗ ${c.name}`);
        console.log(`      ${(e as Error).message.replace(/\n/g, "\n      ")}`);
      }
    }
  }
  console.log(
    `\n${passed} passed, ${failed} failed, ${skipped} skipped (${
      passed + failed + skipped
    } total)`
  );
  if (failed > 0) process.exit(1);
}
