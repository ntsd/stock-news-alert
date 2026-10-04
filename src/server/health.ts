import http from 'node:http';
import type { PollerStats } from '../scheduler/poller.js';

export interface HealthServerOptions {
  port: number;
  getStats: () => PollerStats;
}

export function createHealthServer(options: HealthServerOptions): http.Server {
  const { port, getStats } = options;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health' || url.pathname === '/') {
      const stats = getStats();
      const responsePayload = {
        status: stats.isRunning ? 'healthy' : 'stopped',
        service: 'stock-news-alert',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        stats,
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(responsePayload, null, 2));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(port, () => {
    console.log(`🩺 [Health] HTTP health check server listening on port ${port}`);
  });

  return server;
}
