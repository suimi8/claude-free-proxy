// The child owns the transport. A closed stdout pipe does not mean that the transfer succeeded.
import { PassThrough, Readable } from 'node:stream';

function networkError(reason) {
  return Object.assign(new Error(`upstream network error: ${reason}`), {
    status: 0,
    kind: 'transient',
    retryable: true,
  });
}

export function readChildResponse(child, { signal, requestBody } = {}) {
  return new Promise((resolve, reject) => {
    const out = new PassThrough();
    let head = Buffer.alloc(0),
      published = false,
      closed = false,
      failed = false;
    function terminate() {
      if (!closed && !child.killed) child.kill();
    }
    function fail(err) {
      if (failed) return;
      failed = true;
      if (published)
        out.destroy(err); // delivered to the reader even after headers resolved
      else {
        reject(err);
        out.destroy();
      }
      terminate();
    }
    const abort = () => fail(new DOMException('Client disconnected', 'AbortError'));
    child.once('error', (e) => fail(networkError(e.code || 'process error')));
    // An upstream that exits early can close stdin during a pending write (EPIPE).
    for (const pipe of [child.stdin, child.stdout, child.stderr]) {
      pipe.on('error', (e) => fail(networkError(e.code || 'pipe error')));
    }
    child.stderr.resume(); // never echo subprocess diagnostics, which may contain credentials
    out.on('close', terminate); // also terminates a hanging producer when the body reader cancels
    out.on('drain', () => child.stdout.resume());
    child.stdout.on('data', (chunk) => {
      if (failed || out.destroyed) return;
      if (!published) {
        head = Buffer.concat([head, chunk]);
        for (;;) {
          const end = head.indexOf('\r\n\r\n');
          if ((end < 0 ? head.length : end) > 65536)
            return fail(networkError('response headers too large'));
          if (end < 0) return;
          const [first, ...lines] = head.subarray(0, end).toString('latin1').split('\r\n');
          const status = Number(/^HTTP\/[\d.]+ (\d{3})\b/.exec(first)?.[1]);
          if (!(status >= 100 && status <= 599)) return fail(networkError('invalid response headers'));
          head = head.subarray(end + 4);
          if (status < 200) continue; // e.g. 100 Continue, not the final response
          const headers = new Map();
          for (const line of lines) {
            const i = line.indexOf(':');
            if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
          }
          const body = Readable.toWeb(out);
          const text = () => new Response(body).text();
          published = true;
          resolve({
            status,
            ok: status < 300,
            headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
            body,
            text,
            json: async () => JSON.parse(await text()),
          });
          chunk = head;
          head = null;
          break;
        }
      }
      if (chunk.length && !out.write(chunk)) child.stdout.pause();
    });
    child.once('close', (code, sig) => {
      closed = true;
      signal?.removeEventListener('abort', abort);
      if (failed) return;
      if (!published || code !== 0)
        fail(networkError(`transport exit ${sig || code}${published ? '' : ' before headers'}`));
      else out.end();
    });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(requestBody);
  });
}
