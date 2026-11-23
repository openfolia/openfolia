import { loadavg } from 'node:os';
import { relative } from 'node:path';
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

/**
 * The run's last lines: how long it took (with the load average, since the machine may be
 * shared), the tests that passed only on their retry (flaky: never hidden), and for every
 * failure where its trace, screenshot and console are.
 */
export default class SummaryReporter implements Reporter {
  private readonly started = Date.now();
  private readonly failures = new Map<TestCase, TestResult>();

  onTestEnd(test: TestCase, result: TestResult): void {
    // An expected failure (`test.fail`) is no failure; one that passes is.
    if (result.status !== test.expectedStatus && result.status !== 'skipped') {
      this.failures.set(test, result);
    } else {
      this.failures.delete(test);
    }
  }

  onEnd(result: FullResult): void {
    const seconds = ((Date.now() - this.started) / 1000).toFixed(0);
    const [one, five] = loadavg();
    const lines = [
      `editor-e2e: ${result.status} in ${seconds} s (load average ${one?.toFixed(1)} / ${five?.toFixed(1)}, 1 and 5 min)`,
    ];
    const flaky = [...this.allTests()].filter(
      (test) => test.outcome() === 'flaky',
    );
    if (flaky.length > 0) {
      lines.push(`flaky (passed on the retry only, look into them):`);
      for (const test of flaky) lines.push(`  - ${this.name(test)}`);
    }
    for (const [test, run] of this.failures) {
      lines.push(`failed: ${this.name(test)}`);
      for (const attachment of run.attachments) {
        if (attachment.path) {
          lines.push(
            `  ${attachment.name}: ${relative(process.cwd(), attachment.path)}`,
          );
        }
      }
    }
    console.log(`\n${lines.join('\n')}`);
  }

  private tests: TestCase[] = [];
  onTestBegin(test: TestCase): void {
    if (!this.tests.includes(test)) this.tests.push(test);
  }
  private allTests(): TestCase[] {
    return this.tests;
  }

  private name(test: TestCase): string {
    return `${test.parent.project()?.name ?? ''} › ${test.titlePath().slice(2).join(' › ')}`;
  }

  printsToStdio(): boolean {
    return true;
  }
}
