import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { registerConfigRoutes } from './routes/config.routes.js';
import { registerLogsRoutes } from './routes/logs.routes.js';
import { proxyHandler } from './proxy.js';
// Side-effect import: self-registers the example audit/rewrite hooks at startup
// (gated by GATEWAY_EXAMPLE_HOOKS; enabled by default). Safe to delete — it does
// not modify proxy.ts; the hook seam is the only integration point.
import './hooks/example-audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// <root>/server/{dist|src}/index.{js|ts} -> <root>
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIST = path.join(PROJECT_ROOT, 'web', 'dist');

/**
 * The single reserved root for the gateway's own surface. Everything else is
 * proxied. The proxy catch-all (task #2) must exclude ONLY this prefix.
 */
export const GATEWAY_PREFIX = '/__gateway';

/**
 * Hard transport ceiling for buffered request bodies. The authoritative,
 * user-facing cap is config.captureRequestBodyLimitBytes (enforced in the proxy
 * as a 413); this ceiling just keeps Fastify from rejecting bodies below that
 * cap. Kept comfortably above the 5MB default config cap.
 */
const BODY_LIMIT = 256 * 1024 * 1024;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    bodyLimit: BODY_LIMIT,
  });

  await loadConfig();

  // The proxy forwards request bodies verbatim. Remove Fastify's built-in
  // parsers (notably the default application/json parser, which would otherwise
  // take precedence over our catch-all and reject non-JSON or validate JSON we
  // must forward untouched) and register a single catch-all parser that buffers
  // the raw bytes into `request.body` (a Buffer) for EVERY content type. The
  // 413 over-cap check lives in the proxy using the per-request config snapshot.
  // The config plugin below re-adds JSON parsing inside its encapsulated scope,
  // so /__gateway/api still parses application/json normally. Fastify's
  // bodyLimit is raised because captureRequestBodyLimitBytes is the
  // authoritative cap.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // --- Gateway API (config now; logs added by task #4) ---
  await app.register(
    async (api) => {
      // Restore JSON body parsing inside this encapsulated context only.
      api.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (_req, body, done) => {
          try {
            done(null, body === '' ? undefined : JSON.parse(body as string));
          } catch (err) {
            done(err as Error, undefined);
          }
        },
      );
      await registerConfigRoutes(api);
      await registerLogsRoutes(api);
    },
    { prefix: `${GATEWAY_PREFIX}/api` },
  );

  // --- SPA static hosting under /__gateway/app ---
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: `${GATEWAY_PREFIX}/app/`,
      decorateReply: false,
    });
  } else {
    app.log.warn(
      `[static] ${WEB_DIST} not found — SPA not served (run "pnpm --filter web build"). Continuing in dev.`,
    );
    // Provide a friendly placeholder so the prefix is not proxied as upstream.
    app.get(`${GATEWAY_PREFIX}/app/*`, async (_req, reply) => {
      reply.code(503).type('text/plain');
      return 'web/dist not built yet. Run "pnpm --filter web build".';
    });
  }

  // Redirect root to the SPA entry.
  app.get('/', async (_req, reply) => {
    reply.redirect(`${GATEWAY_PREFIX}/app/`);
  });

  // --- Proxy catch-all (task #2: always-stream-through core) ---
  // Handles every method/path EXCEPT the reserved /__gateway/ prefix, which is
  // owned by the routes registered above. A /__gateway/ path that falls through
  // here is genuinely not found (404); everything else is proxied upstream.
  app.all('/*', async (request, reply) => {
    if (request.url.startsWith(`${GATEWAY_PREFIX}/`)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await proxyHandler(request, reply);
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  return app;
}

// Run only when executed directly (not when imported by tests/other tasks).
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}
