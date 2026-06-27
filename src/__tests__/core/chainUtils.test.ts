import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { makeRequest } from '../../core/chainUtils.js';

describe('chainUtils', () => {
  let server: Server;
  let endpoint = '';
  let flakyAttempts = 0;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/result') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: { ok: true } }));
        return;
      }

      if (req.url === '/raw') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url === '/client-error') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ message: 'Bad Request' }));
        return;
      }

      if (req.url === '/flaky') {
        flakyAttempts += 1;
        if (flakyAttempts === 1) {
          req.socket.destroy();
          return;
        }

        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result: { recovered: true } }));
        return;
      }

      res.statusCode = 404;
      res.end('not found');
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address);
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('unwraps Cosmos REST result payloads', async () => {
    await assert.doesNotReject(async () => {
      const result = await makeRequest([endpoint], '/result');
      assert.deepEqual(result, { ok: true });
    });
  });

  it('returns raw payloads when no result wrapper exists', async () => {
    const result = await makeRequest([endpoint], '/raw');
    assert.deepEqual(result, { ok: true });
  });

  it('does not retry non-rate-limit client errors', async () => {
    await assert.rejects(
      () => makeRequest([endpoint], '/client-error'),
      /Client error 400: Bad Request/
    );
  });

  it('retries transient request failures', async () => {
    const result = await makeRequest([endpoint], '/flaky');
    assert.deepEqual(result, { recovered: true });
    assert.equal(flakyAttempts, 2);
  });
});
