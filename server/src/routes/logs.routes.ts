import type { FastifyInstance, FastifyReply } from 'fastify';
import { clearAllLogs, getExchange, listExchanges } from '../log-reader.js';
import { logEvents, type LogSummary } from '../logger.js';

interface ListQuery {
  limit?: string;
  before?: string;
}

/**
 * Log read API + SSE live tail, mounted under /__gateway/api by index.ts.
 * These are ordinary Fastify-handled responses, fully independent of the
 * hijacked proxy path.
 */
export async function registerLogsRoutes(app: FastifyInstance): Promise<void> {
  // GET /logs?limit&before -> newest-first summaries, ULID-cursor paginated.
  app.get<{ Querystring: ListQuery }>('/logs', async (request) => {
    const { limit, before } = request.query;
    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    const items = await listExchanges({
      limit:
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined,
      before: before || undefined,
    });
    return { items, nextBefore: items.length > 0 ? items[items.length - 1].id : null };
  });

  // GET /logs/stream -> SSE live tail of newly-logged exchanges.
  // Registered before the /:id param route so "stream" is never treated as an
  // id (Fastify prioritizes static segments, but order makes intent explicit).
  app.get('/logs/stream', async (request, reply) => {
    setupSse(reply);

    // Send an initial comment so proxies/clients open the stream immediately.
    reply.raw.write(': connected\n\n');

    const onExchange = (summary: LogSummary): void => {
      // Each emitted summary becomes one SSE data frame. Guard against writing
      // to a socket that has already gone away.
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify(summary)}\n\n`);
    };
    logEvents.on('exchange', onExchange);

    // Heartbeat keeps intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(': ping\n\n');
    }, 15000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      logEvents.removeListener('exchange', onExchange);
    };
    // cleanup is idempotent; wire it to every terminal signal.
    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);

    // Hand the socket to us; do not let Fastify try to serialize a body.
    return reply;
  });

  // GET /logs/:id -> full ExchangeRecord (404 if missing).
  app.get<{ Params: { id: string } }>('/logs/:id', async (request, reply) => {
    const record = await getExchange(request.params.id);
    if (!record) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return record;
  });

  // DELETE /logs -> delete all JSONL log files.
  app.delete('/logs', async () => {
    const deleted = await clearAllLogs();
    return { deleted };
  });
}

/** Write SSE response headers and flush them immediately. */
function setupSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers right away.
  if (typeof reply.raw.flushHeaders === 'function') reply.raw.flushHeaders();
}
