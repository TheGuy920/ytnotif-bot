// Channel list. Edit this and `npm run deploy` to apply.
//
// `webhook` is the NAME of a Worker secret holding the Discord webhook URL
// (set with `npx wrangler secret put <NAME>`), so URLs never land in git.
// Several channels can share one secret / Discord webhook.
//
// Per-channel options (all optional except name/channelId/webhook):
//   filterShorts     - skip YouTube Shorts (default true)
//   announceUpdates  - re-post when YouTube pings an already-announced video
//                      again, e.g. after a title edit (default false)
//   callbackUrl      - override the global CALLBACK_URL for this channel's
//                      hub subscription
//   template         - Discord payload for this channel (default TEMPLATE)

export const TEMPLATE = {
    content: '**{{channelName}}** just uploaded!\n{{videoUrl}}',
};

export const CHANNELS = [
    { name: 'bashbunni', channelId: 'UC9H0HzpKf5JlazkADWnW1Jw', webhook: 'WEBHOOK_BASHBUNNI', filterShorts: true },
    { name: 'Axolotgames', channelId: 'UCK0_Wks3KCgG54GNnDcVwfA', webhook: 'WEBHOOK_AXOLOT', filterShorts: false, announceUpdates: true },
    { name: 'Z1Gaming', channelId: 'UCMPpVtxOI8RtfurfvCcxgyA', webhook: 'WEBHOOK_AXOLOT', filterShorts: false, announceUpdates: true },
    { name: 'kAN', channelId: 'UCFqmcAvY-lLQHJcfOHJavGQ', webhook: 'WEBHOOK_AXOLOT', filterShorts: false, announceUpdates: true },
    { name: 'ScrapMan', channelId: 'UCcZUc0Wbt4EPVktbB8FrugQ', webhook: 'WEBHOOK_AXOLOT', filterShorts: false, announceUpdates: true },
    { name: 'Kosmo', channelId: 'UCy4okQVD1VIz2mqB6qq_q1A', webhook: 'WEBHOOK_AXOLOT', filterShorts: false, announceUpdates: true },
    { name: 'J0hnbane', channelId: 'UCtSKdz7X4QhaL6LgyOhCViQ', webhook: 'WEBHOOK_AXOLOT', filterShorts: false, announceUpdates: true },
];
