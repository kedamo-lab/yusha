import { DurableObject } from 'cloudflare:workers';
import { Feed, handleRequest } from './feed.mjs';

export class TikTokFeed extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.feed = new Feed(ctx.storage, env);
        ctx.blockConcurrencyWhile(() => this.feed.ready);
    }

    async getFeed(cursor) {
        return this.feed.get(cursor);
    }
}

export default { fetch: handleRequest };
