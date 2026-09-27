#!/usr/bin/env node
/**
 * Runs the reference consumer as a standalone process.
 *
 *   WEBHOOK_SECRET=… pnpm -F @suite/webhook-sink start [--port 4000]
 *
 * Useful for pointing a real deployment at something that checks signatures
 * properly, and as a worked example for an integrator.
 */
import { createWebhookSink } from './index.js';

const secret = process.env['WEBHOOK_SECRET'];
if (secret === undefined || secret === '') {
  console.error('WEBHOOK_SECRET is required');
  process.exit(2);
}

const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? 4000 : Number(process.argv[portIndex + 1]);

const sink = createWebhookSink({ secret });
const bound = await sink.listen(port);
console.log(`webhook-sink listening on http://127.0.0.1:${String(bound)}`);
console.log('verifying signatures, rejecting replays older than 5 minutes, deduping on event_id');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void sink.close().then(() => {
      console.log(
        `\nreceived ${String(sink.requestCount())} request(s), ` +
          `${String(sink.processedIds().length)} distinct event(s), ` +
          `${String(sink.rejected.length)} rejected`,
      );
      process.exit(0);
    });
  });
}
