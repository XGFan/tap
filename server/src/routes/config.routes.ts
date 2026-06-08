import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { getConfig, update } from '../config.js';
import { upstreamConfigUpdateSchema } from '../types.js';

/**
 * Config management routes, mounted under /__gateway/api by index.ts.
 *   GET  /config  -> current immutable config
 *   PUT  /config  -> zod-validate body, reject baseUrl-with-path (400), persist
 */
export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async () => {
    return getConfig();
  });

  app.put('/config', async (request, reply) => {
    const parsed = upstreamConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'invalid_config',
        details: parsed.error.flatten(),
      };
    }
    try {
      const next = await update(parsed.data);
      return next;
    } catch (err) {
      // update() re-validates the merged object; surface validation failures as 400.
      if (err instanceof ZodError) {
        reply.code(400);
        return { error: 'invalid_config', details: err.flatten() };
      }
      throw err;
    }
  });
}
