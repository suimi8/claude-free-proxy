// No account credentials, no upstream request. Run in the same network namespace as the client.
import http from 'node:http';
const port = Number(process.argv[2] || process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const req = http.get(
  { hostname: '127.0.0.1', port, path: '/readyz', agent: false, signal: AbortSignal.timeout(2500) },
  (res) => {
    const ok = res.statusCode === 200 && res.headers['x-gateway-service'] === 'claude-desktop-proxy';
    res.destroy();
    console.log(
      ok
        ? `Gateway ready on ${port}`
        : `Port ${port} answered HTTP ${res.statusCode} without this gateway readiness signature (older version or another service)`
    );
    process.exitCode = ok ? 0 : 1;
  }
);
req.on('error', (e) => {
  console.error(`Gateway unavailable on local port ${port}: ${e.code || e.name}`);
  process.exitCode = 1;
});
