import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const DAY = 86_400_000;
export const T0 = Date.parse('2026-01-05T12:00:00Z');

export class TempRepo {
  readonly dir = mkdtempSync(join(tmpdir(), 'agent-dora-'));

  constructor() {
    this.git(0, 'init', '-q', '-b', 'main');
    this.git(0, 'config', 'user.email', 'test@example.com');
    this.git(0, 'config', 'user.name', 'Test');
    this.git(0, 'config', 'commit.gpgsign', 'false');
  }

  git(at: number, ...args: string[]): string {
    const date = new Date(at || T0).toISOString();
    return execFileSync('git', ['-C', this.dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    }).trim();
  }

  write(path: string, lines: string[]): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, lines.join('\n') + '\n');
  }

  commit(at: number, message: string): string {
    this.git(at, 'add', '-A');
    this.git(at, 'commit', '-q', '-m', message);
    return this.git(at, 'rev-parse', 'HEAD');
  }
}

export const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`);
