/** Regenerate rewrite-rules.json from rules.mjs (correct escaping by construction). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showcaseRules } from './rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, 'rewrite-rules.json');
await fs.writeFile(out, JSON.stringify(showcaseRules, null, 2) + '\n', 'utf8');
console.log(`Wrote ${out} (${showcaseRules.length} rules)`);
