// Fills the KV namespace id into wrangler.jsonc from the KV_STORE_ID
// environment variable, so no account-specific id is committed. wrangler
// can't read env vars from its config, hence this step.
//
//   node scripts/inject-kv-id.mjs            write the id in place (Workers Builds build command)
//   node scripts/inject-kv-id.mjs <cmd...>   write it, run <cmd>, then restore the placeholder

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PLACEHOLDER = 'KV_STORE_ID';
const file = new URL('../wrangler.jsonc', import.meta.url);

const id = process.env.KV_STORE_ID?.trim() ?? '';
if (!/^[0-9a-f]{32}$/i.test(id)) {
    console.error(
        'KV_STORE_ID must be set to your KV namespace id (32 hex characters).\n' +
        'Find it with `npx wrangler kv namespace list`. In Workers Builds, add it under\n' +
        'Settings → Build → Variables and secrets.'
    );
    process.exit(1);
}

const original = readFileSync(file, 'utf8');
const pattern = new RegExp(`("id"\\s*:\\s*)"${PLACEHOLDER}"`, 'g');
const count = original.match(pattern)?.length ?? 0;
if (count === 0) {
    console.error(`No "id": "${PLACEHOLDER}" placeholder found in wrangler.jsonc.`);
    process.exit(1);
}
writeFileSync(file, original.replace(pattern, `$1"${id}"`));
console.log(`Set the KV namespace id in ${count} place(s) in wrangler.jsonc.`);

const [cmd, ...args] = process.argv.slice(2);
if (cmd) {
    // Let Ctrl-C reach the child but keep this process alive to restore the file.
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { });
    const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    writeFileSync(file, original);
    process.exit(result.status ?? 1);
}
