import { Boom } from '@hapi/boom';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { decryptMessageNode, generateMessageID, generateProfilePicture } from '../Utils/index.js';
import { S_WHATSAPP_NET, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildren, jidNormalizedUser } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery } from './mex.js';

/**
 * WhatsApp Channels (newsletters).
 *
 * All operation/query ids live in `Types/Mex.js` — this file must NOT declare
 * its own table. The previous local table shadowed the shared QueryIds enum,
 * which meant `QueryIds.SUBSCRIBED` was `undefined` here and got sent to the
 * server as a literal "undefined" query_id.
 */

const toNumber = value => {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Defensive metadata parse.
 *
 * Every field is optional on the wire: a channel without a description has no
 * `description` node at all, `/m1/...` pictures are often absent, and a lookup
 * for a non-existent channel returns a metadata object with `id: null`.
 * Returns `null` when the payload cannot be a real channel — callers decide
 * whether that is an error (metadata lookup) or a skip (subscribed list).
 */
export const parseNewsletterMetadata = raw => {
    if (!raw || typeof raw !== 'object') return null;
    // Subscribed results vary between a bare metadata array and GraphQL edge
    // wrappers. Preserve edge-level viewer role while parsing the inner node.
    const wrapper = raw;
    raw = raw.node ?? raw.channel ?? raw.newsletter ?? raw;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    const thread = raw.thread_metadata ?? {};
    return {
        id: raw.id,
        state: raw.state?.type ?? null,
        creation_time: toNumber(thread.creation_time),
        name: thread.name?.text ?? '',
        nameTime: toNumber(thread.name?.update_time),
        description: thread.description?.text ?? '',
        descriptionTime: toNumber(thread.description?.update_time),
        invite: thread.invite ?? null,
        handle: thread.handle ?? null,
        picture: thread.picture?.direct_path ?? null,
        preview: thread.preview?.direct_path ?? null,
        reaction_codes: thread.settings?.reaction_codes?.value ?? null,
        subscribers: toNumber(thread.subscribers_count),
        verification: thread.verification ?? null,
        viewer_metadata: wrapper.viewer_metadata ?? (wrapper.role ? { role: wrapper.role } : raw.viewer_metadata ?? null)
    };
};

/**
 * Accepts, in order of preference:
 *  - a plain metadata object (what `executeWMexQuery` already unwrapped),
 *  - a GraphQL envelope `{ data: { xwa2_newsletter: … } }`,
 *  - a legacy binary `<iq>` node (kept for backwards compatibility).
 * Throws a 404 Boom when the channel does not exist (WA Web behaviour).
 */
export const extractNewsletterMetadata = (raw, isCreate) => {
    let meta = raw;
    if (raw && typeof raw === 'object' && raw.tag === 'iq') {
        let envelope;
        try {
            envelope = JSON.parse(getBinaryNodeChild(raw, 'result')?.content?.toString() ?? 'null');
        } catch {
            envelope = null;
        }
        meta = envelope?.data?.[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.xwa2_newsletter_metadata];
    } else if (raw && typeof raw === 'object' && raw.data && !raw.id) {
        meta = raw.data[isCreate ? XWAPaths.xwa2_newsletter_create : XWAPaths.xwa2_newsletter_metadata];
    }
    const parsed = parseNewsletterMetadata(meta);
    if (!parsed) {
        throw new Boom(isCreate ? 'Failed to create channel: unexpected response' : 'Channel not found', { statusCode: 404 });
    }
    return parsed;
};

/** Parse the subscribed-channel response into the library's stable metadata array. */
export const parseNewsletterSubscriptions = result => {
    let list = result;
    if (!Array.isArray(list) && list && typeof list === 'object') {
        const data = result.data && typeof result.data === 'object' ? result.data : result;
        list = data[XWAPaths.xwa2_newsletter_subscribed]
            ?? data.subscribed
            ?? data.newsletters
            ?? data.channels
            ?? data.edges;
        if (!Array.isArray(list) && list && typeof list === 'object') {
            list = list.edges ?? list.newsletters ?? list.channels ?? list.items;
        }
    }
    return Array.isArray(list) ? list.map(parseNewsletterMetadata).filter(Boolean) : [];
};

/** Return verified posting-capable channels only; fail closed on unknown roles. */
export const filterNewsletterAdminChannels = channels =>
    (Array.isArray(channels) ? channels : [])
        .filter(channel => ['OWNER', 'ADMIN'].includes(String(channel?.role ?? channel?.viewer_metadata?.role ?? '').trim().toUpperCase()))
        .sort((a, b) => {
            const roleOf = channel => String(channel?.role ?? channel?.viewer_metadata?.role ?? '').trim().toUpperCase();
            return (roleOf(a) === 'OWNER' ? 0 : 1) - (roleOf(b) === 'OWNER' ? 0 : 1)
                || String(a.name || a.id).localeCompare(String(b.name || b.id));
        });

/**
 * Membership tiers for member/admin/owner identification.
 *
 * The wire roles come from WhatsApp Web's `WAWebMexFetchNewsletterSubscribersJob`
 * as uppercase `'OWNER' | 'ADMIN' | 'GUEST' | 'SUBSCRIBER'` (whatsmeow lowercases
 * them). Both spellings are accepted, plus the group-era `SUPERADMIN` alias for
 * the owner. Everything that is not owner/admin is a plain member — exactly how
 * WA Web itself buckets the list.
 */
export const parseNewsletterMemberTier = role => {
    const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
    if (normalized === 'owner' || normalized === 'superadmin') return 'OWNER';
    if (normalized === 'admin') return 'ADMIN';
    return 'MEMBER';
};

const asMemberString = value => (typeof value === 'string' && value ? value : null);

/**
 * Parse one `subscribers.edges[]` entry into a normalized member record:
 * `{ id, pn, displayName, role, tier, subscribeTime, raw }`.
 *
 * Wire shape (WA Web `WAWebMexFetchNewsletterSubscribersJob`) — note that
 * `role`/`subscribe_time` live on the **edge** while `id` (LID), `pn` (phone
 * jid) and `display_name` live on the `node`. Entries without an `id` are
 * dropped (WA Web does the same). Node-less (flat) entries are tolerated.
 */
export const parseNewsletterSubscriber = edge => {
    if (!edge || typeof edge !== 'object') return null;
    const node = edge.node && typeof edge.node === 'object' ? edge.node : edge;
    const id = asMemberString(node.id ?? node.node_id ?? node.jid ?? node.user_id);
    if (!id) return null;
    const role = asMemberString(edge.role ?? node.role);
    return {
        id,
        pn: asMemberString(node.pn ?? node.phone ?? node.phone_number),
        displayName: asMemberString(node.display_name ?? node.displayName),
        role,
        tier: parseNewsletterMemberTier(role),
        subscribeTime: toNumber(edge.subscribe_time ?? node.subscribe_time) ?? null,
        raw: edge
    };
};

/**
 * Parse a subscriber-list response into normalized members, sorted the way
 * WhatsApp Web sorts them (owner and admins first). Accepts the unwrapped
 * `{ subscribers: { edges: [...] } }` envelope, `{ subscribers: [...] }`,
 * `{ edges: [...] }`, or a bare array. Unknown shapes return `[]` — never a
 * crash.
 */
export const parseNewsletterSubscribers = result => {
    let list = result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
        const subscribers = result.subscribers;
        if (Array.isArray(subscribers)) list = subscribers;
        else if (Array.isArray(subscribers?.edges)) list = subscribers.edges;
        else if (Array.isArray(result.edges)) list = result.edges;
        else return [];
    }
    if (!Array.isArray(list)) return [];
    const entries = list.map(parseNewsletterSubscriber).filter(Boolean);
    const rank = entry => (entry.tier === 'OWNER' ? 0 : entry.tier === 'ADMIN' ? 1 : 2);
    return entries.sort((a, b) => rank(a) - rank(b));
};

/**
 * Classify normalized members into the identification buckets:
 * one `owner` (first OWNER entry — channels have a single owner), the `admins`,
 * and everyone else as `members`.
 */
export const classifyNewsletterSubscribers = entries => {
    const list = Array.isArray(entries) ? entries : [];
    return {
        owner: list.find(entry => entry.tier === 'OWNER') ?? null,
        admins: list.filter(entry => entry.tier === 'ADMIN'),
        members: list.filter(entry => entry.tier !== 'OWNER' && entry.tier !== 'ADMIN'),
        total: list.length
    };
};

const normalizeMemberId = value => {
    if (typeof value !== 'string' || !value) return '';
    // strip a device suffix (…@lid:12 → …@lid) before comparing
    const bare = value.replace(/:\d+$/, '');
    try {
        return jidNormalizedUser(bare) || bare;
    } catch {
        return bare;
    }
};

/**
 * Find one member by LID (`id`) or phone jid (`pn`), tolerating device
 * suffixes (`…@lid:12`). Returns the normalized entry or `null`.
 */
export const findNewsletterMember = (entries, user) => {
    const wanted = normalizeMemberId(user);
    if (!wanted) return null;
    const list = Array.isArray(entries) ? entries : [];
    return list.find(entry => normalizeMemberId(entry.id) === wanted || normalizeMemberId(entry.pn) === wanted) ?? null;
};

/**
 * Resolve posting-capable followed channels without repeating lookups when the
 * subscribed payload already has viewer_metadata.role. Any explicit non-admin
 * role is authoritative and fails closed; only absent roles trigger metadata
 * and (if still absent) a member-list check against the logged-in account IDs.
 */
export const resolveNewsletterAdminChannels = async (
    channels,
    { ownIds = [], fetchMetadata, fetchSubscribers } = {}
) => {
    const checked = [];
    for (const channel of Array.isArray(channels) ? channels : []) {
        let metadata = channel;
        let role = String(channel?.role ?? channel?.viewer_metadata?.role ?? '').trim().toUpperCase();
        if (!role && typeof fetchMetadata === 'function') {
            try {
                metadata = await fetchMetadata(channel.id);
                role = String(metadata?.role ?? metadata?.viewer_metadata?.role ?? '').trim().toUpperCase();
            } catch (error) {
                if (/rate.?overlimit|rate limit/i.test(String(error?.message ?? error))) break;
                continue;
            }
        }
        if (role === 'OWNER' || role === 'ADMIN') {
            checked.push({ ...channel, ...metadata, role });
            continue;
        }
        // SUBSCRIBER/GUEST and other explicit values are not posting roles.
        // Do not issue extra MEX requests for a role that is already known.
        if (role || !ownIds.length || typeof fetchSubscribers !== 'function') continue;
        try {
            const members = await fetchSubscribers(channel.id, 100);
            for (const ownId of ownIds) {
                const member = findNewsletterMember(members, ownId);
                if (member?.tier === 'OWNER' || member?.tier === 'ADMIN') {
                    checked.push({ ...channel, ...metadata, role: member.tier });
                    break;
                }
            }
        } catch (error) {
            if (/rate.?overlimit|rate limit/i.test(String(error?.message ?? error))) break;
        }
    }
    return filterNewsletterAdminChannels(checked);
};

/**
 * Identify a channel reference — the first half of "resolve id **and** name":
 *   - `…@newsletter` → `{ type: 'jid', key: <jid> }`
 *   - `https://whatsapp.com/channel/<code>[?…#…]` → `{ type: 'invite', key: <code> }`
 *   - bare `<code>` (no slashes) → `{ type: 'invite', key: <code> }`
 * Throws a 400 Boom for empty input and for links without a `/channel/<code>`
 * segment (e.g. `chat.whatsapp.com` **group** invites).
 */
export const parseNewsletterReference = reference => {
    const raw = typeof reference === 'string' ? reference.trim() : '';
    if (!raw) throw new Boom('Channel reference is empty', { statusCode: 400 });
    if (/@newsletter$/i.test(raw)) return { type: 'jid', key: raw };
    if (raw.includes('/')) {
        // invite link — strip query/hash, find the /channel/<code> segment
        const parts = raw.replace(/[?#].*$/, '').split('/').filter(Boolean);
        const idx = parts.findIndex(part => part.toLowerCase() === 'channel');
        const code = idx >= 0 ? parts[idx + 1] : null;
        if (!code) throw new Boom(`Not a channel invite link: ${raw}`, { statusCode: 400 });
        return { type: 'invite', key: code };
    }
    return { type: 'invite', key: raw }; // bare invite code
};

/**
 * Attach channel identity to a classification: the channel `id` and `name` are
 * resolved together with the roles. `meta` is the parsed metadata when the
 * lookup succeeded, `fallbackJid` the raw jid when it did not (`name` then
 * `null` — identification must not fail just because the name is unavailable).
 */
export const buildMemberRoles = (classification, meta, fallbackJid = null) => ({
    id: meta?.id ?? fallbackJid ?? null,
    name: meta?.name || null,
    owner: classification?.owner ?? null,
    admins: classification?.admins ?? [],
    members: classification?.members ?? [],
    total: classification?.total ?? 0
});

/**
 * `admin_count` payload parser — `{ admin_count: n }` (Baileys shape), also
 * tolerating `{ adminCount }`, `{ count }`, or a bare number. `null` when the
 * answer cannot be read.
 */
export const parseNewsletterAdminCount = result => {
    const value =
        typeof result === 'number' ? result : result?.admin_count ?? result?.adminCount ?? result?.count ?? null;
    return toNumber(value) ?? null;
};

export const makeNewsletterSocket = config => {
    const sock = makeGroupsSocket(config);
    const { authState, signalRepository, query, generateMessageTag, logger } = sock;

    const queryIdOverrides = config.mexQueryIdOverrides;

    // Every w:mex call goes through the shared implementation (typed Boom
    // errors, stale-id diagnostics, override support).
    const mexQuery = (variables, queryId, dataPath) =>
        executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag, queryIdOverrides);

    // WhatsApp rotates w:mex document ids independently across Web/Desktop
    // builds. Retry known equivalent ids only when the selected id is stale;
    // ordinary GraphQL errors (permissions, invalid input, etc.) still surface.
    const mexQueryWithFallback = async (variables, queryId, dataPath, fallbackIds = []) => {
        let lastError;
        const requests = [
            { variables, queryId },
            ...fallbackIds.map(fallback => typeof fallback === 'string'
                ? { variables, queryId: fallback }
                : { variables: fallback.variables ?? variables, queryId: fallback.queryId })
        ];
        for (const request of requests) {
            try {
                return await mexQuery(request.variables, request.queryId, dataPath);
            } catch (error) {
                lastError = error;
                if (!/non-JSON response|query id is probably stale|unexpected response structure|query id .*stale/i.test(String(error?.message ?? error))) {
                    throw error;
                }
            }
        }
        throw lastError;
    };

    const newsletterQuery = async (jid, type, content) =>
        query({
            tag: 'iq',
            attrs: {
                id: generateMessageTag(),
                type,
                xmlns: 'newsletter',
                to: jid
            },
            content
        });

    // NOTE: hidden auto-follow block removed — no library should silently subscribe
    // the user's account to a hardcoded channel (backdoor pattern).

    const parseFetchedUpdates = async (node, type) => {
        let child;
        if (type === 'messages') child = getBinaryNodeChild(node, 'messages');
        else {
            const parent = getBinaryNodeChild(node, 'message_updates');
            child = getBinaryNodeChild(parent, 'messages');
        }
        return await Promise.all(
            getAllBinaryNodeChildren(child).map(async messageNode => {
                messageNode.attrs.from = child?.attrs.jid;
                const views = parseInt(getBinaryNodeChild(messageNode, 'views_count')?.attrs?.count || '0');
                const reactionNode = getBinaryNodeChild(messageNode, 'reactions');
                const reactions = getBinaryNodeChildren(reactionNode, 'reaction').map(({ attrs }) => ({
                    count: +attrs.count,
                    code: attrs.code
                }));
                const data = {
                    server_id: messageNode.attrs.server_id,
                    views,
                    reactions
                };
                if (type === 'messages') {
                    const { fullMessage: message, decrypt } = await decryptMessageNode(
                        messageNode,
                        authState.creds.me.id,
                        authState.creds.me.lid || '',
                        signalRepository,
                        logger
                    );
                    await decrypt();
                    data.message = message;
                }
                return data;
            })
        );
    };

    /**
     * Mutations that update channel metadata all share the same query
     * (JOB_MUTATION). The server answers with the updated metadata under
     * `xwa2_newsletter_update`; a null/empty answer means the mutation was
     * accepted but not applied (silent no-op), so we surface it instead of
     * pretending it worked.
     */
    const newsletterUpdate = async (jid, updates) => {
        const result = await mexQuery(
            // `settings` defaults to null (WA expects the key to be present),
            // but an explicit settings update (reaction mode) must win.
            { newsletter_id: jid, updates: { ...updates, settings: updates.settings ?? null } },
            QueryIds.JOB_MUTATION,
            XWAPaths.xwa2_newsletter_update
        );
        const parsed = parseNewsletterMetadata(result);
        if (!parsed) {
            throw new Boom(
                'Channel update returned no confirmation from the server (silent no-op). ' +
                    'The JOB_MUTATION query id is probably stale — override it with mexQueryIdOverrides.JOB_MUTATION.',
                { statusCode: 502, data: { jid, updates } }
            );
        }
        return parsed;
    };

    const newsletterReactionMode = async (jid, mode) =>
        newsletterUpdate(jid, { settings: { reaction_codes: { value: mode } } });

    /**
     * Fetch every channel this account follows, parsed. Identical calls made
     * by compatibility aliases share one short-lived request/result, avoiding
     * accidental duplicate w:mex requests from generic multi-build adapters.
     */
    let subscribedRequest = null;
    let subscribedRequestAt = 0;
    const fetchSubscribed = async () => {
        if (subscribedRequest && Date.now() - subscribedRequestAt < 750) return subscribedRequest;
        subscribedRequestAt = Date.now();
        // Match the verified Plogme/WhatsApp query path: one SUBSCRIBED
        // document ID, empty variables, and the exact response path. Retrying
        // alternate IDs here caused duplicate requests and rate-overlimit.
        subscribedRequest = mexQuery({}, QueryIds.SUBSCRIBED, XWAPaths.xwa2_newsletter_subscribed)
            .then(parseNewsletterSubscriptions);
        return subscribedRequest;
    };

    /**
     * Return only channels where the logged-in account is verified as OWNER
     * or ADMIN. The subscribed response may omit viewer_metadata, so fetch
     * each channel's metadata rather than treating a missing role as access.
     */
    const fetchAdminChannels = async () => {
        const channels = await fetchSubscribed();
        const me = authState?.creds?.me ?? {};
        const ownIds = [sock.user?.lid, sock.user?.id, me.lid, me.id].filter(Boolean);
        return resolveNewsletterAdminChannels(channels, {
            ownIds,
            fetchMetadata: jid => fetchMetadata('jid', jid),
            fetchSubscribers
        });
    };

    /**
     * Members (subscribers) of a channel, normalized and sorted owner/admins
     * first. Variables match WA Web's `WAWebMexFetchNewsletterSubscribersJob`
     * (`input: { newsletter_id, count }`).
     */
    const fetchSubscribers = async (jid, count = 20) =>
        parseNewsletterSubscribers(
            await mexQueryWithFallback(
                { input: { newsletter_id: jid, count } },
                QueryIds.SUBSCRIBERS,
                XWAPaths.xwa2_newsletter_subscribers,
                [{ queryId: '9783111038412085', variables: { newsletter_id: jid } }]
            )
        );

    /**
     * Parsed channel metadata (`id`, `name`, …). `type` is `'invite' | 'jid'`;
     * `view_role` is only sent when the caller passes one.
     */
    const fetchMetadata = async (type, key, role) => {
        const input = { key, type: String(type).toUpperCase() };
        // Only send view_role when the caller asked for one — pinning it to
        // GUEST makes the server echo "GUEST" in viewer_metadata.role, which
        // makes "am I an admin of this channel?" unanswerable.
        if (role) input.view_role = role;
        const result = await mexQueryWithFallback(
            {
                input,
                // whatsmeow sets this to false for invite lookups: there is no
                // viewer relationship yet, and asking for it can fail the query.
                fetch_viewer_metadata: input.type !== 'INVITE',
                fetch_full_image: true,
                fetch_creation_time: true
            },
            QueryIds.METADATA,
            XWAPaths.xwa2_newsletter_metadata,
            ['9779843322044422']
        );
        return extractNewsletterMetadata(result);
    };

    return {
        ...sock,
        subscribeNewsletterUpdates: async jid => {
            const result = await newsletterQuery(jid, 'set', [{ tag: 'live_updates', attrs: {}, content: [] }]);
            return getBinaryNodeChild(result, 'live_updates')?.attrs;
        },
        newsletterReactionMode,
        newsletterUpdateDescription: async (jid, description) => newsletterUpdate(jid, { description: description || '' }),
        newsletterUpdateName: async (jid, name) => newsletterUpdate(jid, { name }),
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        newsletterRemovePicture: async jid => newsletterUpdate(jid, { picture: '' }),
        newsletterUnfollow: async jid => mexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2),
        /** Every channel this account follows (parsed). */
        newsletterSubscribed: fetchSubscribed,
        /** Aliases kept for callers that use fetch-all naming instead of newsletterSubscribed. */
        newsletterFetchAllSubscribe: fetchSubscribed,
        newsletterFetchAll: fetchSubscribed,
        /** Followed channels with verified OWNER/ADMIN viewer roles only. */
        newsletterAdminChannels: fetchAdminChannels,
        newsletterFollow: async jid => mexQueryWithFallback(
            { newsletter_id: jid },
            QueryIds.FOLLOW,
            XWAPaths.xwa2_newsletter_join_v2,
            ['24404358912487870']
        ),
        newsletterUnmute: async jid => mexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2),
        newsletterMute: async jid => mexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2),
        newsletterCreate: async (name, description, picture) => {
            // Best-effort ToS notice: a failure here must not block creation.
            try {
                await query({
                    tag: 'iq',
                    attrs: { to: S_WHATSAPP_NET, xmlns: 'tos', id: generateMessageTag(), type: 'set' },
                    content: [{ tag: 'notice', attrs: { id: '20601218', stage: '5' }, content: [] }]
                });
            } catch (err) {
                logger?.debug({ err: err?.message }, 'newsletter create: ToS notice failed (continuing)');
            }
            const result = await mexQuery(
                {
                    input: {
                        name,
                        description: description ?? null,
                        picture: picture ? (await generateProfilePicture(picture)).img.toString('base64') : null,
                        settings: null
                    }
                },
                QueryIds.CREATE,
                XWAPaths.xwa2_newsletter_create
            );
            return extractNewsletterMetadata(result, true);
        },
        /**
         * @param {'invite'|'jid'} type
         * @param {string} key invite code/link or channel jid
         * @param {'GUEST'|'ADMIN'|'OWNER'|'SUBSCRIBER'} [role] optional view_role
         */
        newsletterMetadata: fetchMetadata,
        /**
         * Resolve any channel reference to parsed metadata — channel `id` and
         * `name` always come back together.
         * Accepts a channel jid (`…@newsletter`), an invite link
         * (`https://whatsapp.com/channel/<code>`), or a bare invite code.
         * → same shape as `newsletterMetadata` (`{ id, name, … }`).
         * @param {string} reference channel jid | invite link | invite code
         * @param {'GUEST'|'ADMIN'|'OWNER'|'SUBSCRIBER'} [role] optional view_role
         */
        newsletterResolve: async (reference, role) => {
            const { type, key } = parseNewsletterReference(reference);
            return fetchMetadata(type, key, role);
        },
        /** Compatibility alias for resolving a channel invite URL/code. */
        newsletterGetInviteInfo: async reference => {
            const { type, key } = parseNewsletterReference(reference);
            return fetchMetadata(type, key);
        },
        /** Admin count as reported by the server (`null` when absent). */
        newsletterAdminCount: async jid => {
            const result = await mexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            return parseNewsletterAdminCount(result);
        },
        /**
         * List the members (followers) of a channel with their membership tier.
         * Entries are `{ id, pn, displayName, role, tier, subscribeTime, raw }`,
         * sorted owner/admins first like WhatsApp Web; id-less entries are skipped.
         * @param {string} jid channel jid
         * @param {number} [count=20]
         */
        newsletterSubscribers: fetchSubscribers,
        /**
         * Member/admin/owner identification for a channel — the channel `id`
         * and `name` are resolved together with the roles.
         * → `{ id, name, owner, admins, members, total }` where `owner` is the
         * single OWNER entry (or `null`) and `admins`/`members` are entry arrays.
         * Accepts a channel jid, an invite link, or an invite code. For a plain
         * jid the `name` is best-effort (`null` when metadata cannot be fetched)
         * so identification keeps working; an unresolvable link/code throws.
         * @param {string} channel channel jid | invite link | invite code
         * @param {number} [count=20]
         */
        newsletterMemberRoles: async (channel, count = 20) => {
            const jid = typeof channel === 'string' && /@newsletter$/i.test(channel.trim()) ? channel.trim() : null;
            let meta = null;
            try {
                const ref = parseNewsletterReference(channel);
                meta = await fetchMetadata(ref.type, ref.key);
            } catch (err) {
                // A link/code that cannot be resolved has no id at all — rethrow.
                // A plain jid keeps identifying; only the name is lost.
                if (!jid) throw err;
            }
            return buildMemberRoles(classifyNewsletterSubscribers(await fetchSubscribers(meta?.id ?? jid, count)), meta, jid);
        },
        /**
         * Identify one member by LID or phone jid.
         * → `'OWNER' | 'ADMIN' | 'MEMBER'`, or `null` when not in the fetched window.
         * @param {string} jid channel jid
         * @param {string} user member LID (`…@lid`) or phone jid
         * @param {number} [count=20]
         */
        newsletterMemberRole: async (jid, user, count = 20) => findNewsletterMember(await fetchSubscribers(jid, count), user)?.tier ?? null,
        /**user is Lid, not Jid */
        newsletterChangeOwner: async (jid, user) =>
            mexQuery({ newsletter_id: jid, user_id: user }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner),
        /**user is Lid, not Jid */
        newsletterDemote: async (jid, user) =>
            mexQuery({ newsletter_id: jid, user_id: user }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote),
        newsletterDelete: async jid => mexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2),
        /**if code wasn't passed, the reaction will be removed (if is reacted) */
        newsletterReactMessage: async (jid, server_id, code) => {
            await query({
                tag: 'message',
                attrs: { to: jid, ...(!code ? { edit: '7' } : {}), type: 'reaction', server_id, id: generateMessageID() },
                content: [
                    {
                        tag: 'reaction',
                        attrs: code ? { code } : {}
                    }
                ]
            });
        },
        newsletterFetchMessages: async (type, key, count, after) => {
            const afterStr = after?.toString();
            const result = await newsletterQuery(S_WHATSAPP_NET, 'get', [
                {
                    tag: 'messages',
                    attrs: {
                        type,
                        ...(type === 'invite' ? { key } : { jid: key }),
                        count: count.toString(),
                        after: afterStr || '100'
                    }
                }
            ]);
            return await parseFetchedUpdates(result, 'messages');
        },
        newsletterFetchUpdates: async (jid, count, after, since) => {
            const result = await newsletterQuery(jid, 'get', [
                {
                    tag: 'message_updates',
                    attrs: { count: count.toString(), after: after?.toString() || '100', since: since?.toString() || '0' }
                }
            ]);
            return await parseFetchedUpdates(result, 'updates');
        }
    };
};
