import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AdapterError } from '../shared/types.ts';

/** Windows PowerShell 5.1 by absolute path (works even if PATH is minimal); falls back to PATH lookup. */
const POWERSHELL = ((): string => {
  const p = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(p) ? p : 'powershell.exe';
})();

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** Long-running PowerShell UIA helper speaking JSON lines. Started lazily, restarted if it dies. */
export class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** Serialise requests: UIA calls are not safe to interleave against one window. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private scriptPath: string) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
      windowsHide: true,
    });
    createInterface({ input: p.stdout }).on('line', (line) => {
      let msg: { id: number; ok: boolean; result?: unknown; error?: string; detail?: string };
      try { msg = JSON.parse(line); } catch { return; }
      const w = this.pending.get(msg.id);
      if (!w) return;
      this.pending.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new AdapterError(msg.error ?? 'sidecar-error', msg.detail ?? 'sidecar error'));
    });
    p.stderr.on('data', () => { /* PowerShell noise; real errors come back as JSON */ });
    // A failed spawn (PowerShell missing) must become an adapter error, never an unhandled crash of the hub.
    p.on('error', (e) => {
      this.proc = null;
      for (const [id, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new AdapterError('sidecar-unavailable', `Could not start Windows PowerShell for the UIA sidecar: ${e.message}`));
        this.pending.delete(id);
      }
    });
    p.stdin.on('error', () => { /* surfaced through the error/exit handlers */ });
    p.on('exit', () => {
      this.proc = null;
      for (const [id, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new AdapterError('sidecar-died', 'UIA sidecar exited'));
        this.pending.delete(id);
      }
    });
    this.proc = p;
    return p;
  }

  call<T>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    const run = () => new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('sidecar-timeout', `UIA sidecar timed out on ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.start().stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
