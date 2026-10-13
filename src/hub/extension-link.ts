import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';
import { AdapterError, type ExtRequest, type ExtResponse } from '../shared/types.ts';

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * WebSocket endpoint the browser extension's service worker connects to.
 * Loopback only; only connections whose Origin is a chrome-extension:// page are accepted
 * (web pages cannot forge that Origin).
 */
export class ExtensionLink {
  private sock: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(server: Server) {
    const wss = new WebSocketServer({
      server,
      path: '/ext',
      verifyClient: ({ origin }: { origin?: string }) => typeof origin === 'string' && origin.startsWith('chrome-extension://'),
    });
    wss.on('connection', (ws) => {
      this.sock?.close();
      this.sock = ws;
      ws.on('message', (data) => {
        let m: ExtResponse;
        try { m = JSON.parse(String(data)); } catch { return; }
        if ((m as { id?: number }).id == null) return; // keepalive pings etc.
        const w = this.pending.get(m.id);
        if (!w) return;
        this.pending.delete(m.id);
        clearTimeout(w.timer);
        if (m.ok) w.resolve(m.result);
        else w.reject(new AdapterError(m.error, m.detail ?? m.error));
      });
      ws.on('close', () => {
        if (this.sock === ws) this.sock = null;
        for (const [id, w] of this.pending) {
          clearTimeout(w.timer);
          w.reject(new AdapterError('extension-disconnected', 'Extension disconnected'));
          this.pending.delete(id);
        }
      });
    });
    // Keep the MV3 service worker alive while connected (WebSocket traffic resets its idle timer).
    setInterval(() => { if (this.connected) this.sock!.send('{"ping":1}'); }, 20000).unref();
  }

  get connected(): boolean { return this.sock?.readyState === 1; }

  request<T>(req: Omit<ExtRequest, 'id'>, timeoutMs = 15000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.connected) return reject(new AdapterError('extension-disconnected', 'Extension not connected'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError('extension-timeout', `Extension did not answer ${req.op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.sock!.send(JSON.stringify({ id, ...req }));
    });
  }
}
