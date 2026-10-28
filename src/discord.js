// Deep-substitutes {{placeholder}} tokens in every string of a template.
export function render(value, placeholders) {
    if (typeof value === 'string') {
        return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) =>
            Object.hasOwn(placeholders, key) ? String(placeholders[key]) : match
        );
    }
    if (Array.isArray(value)) return value.map((v) => render(v, placeholders));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, placeholders)]));
    }
    return value;
}

// POSTs to a Discord webhook, retrying on 429. username/avatar_url are
// stripped so the webhook's own configured name and avatar are always used.
export async function sendDiscordMessage(webhookUrl, payload, { maxRetries = 3 } = {}) {
    const { username, avatar_url, ...body } = payload;

    for (let attempt = 1; ; attempt++) {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.ok) return;

        if (res.status === 429 && attempt <= maxRetries) {
            let retryAfter = Number(res.headers.get('retry-after')) || 1;
            try {
                const data = await res.json();
                if (typeof data.retry_after === 'number') retryAfter = data.retry_after;
            } catch { }
            console.warn(`[discord] Rate limited (attempt ${attempt}/${maxRetries}), retrying in ${retryAfter}s`);
            await new Promise((r) => setTimeout(r, retryAfter * 1000 + 50));
            continue;
        }

        const text = await res.text().catch(() => '');
        throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
}
