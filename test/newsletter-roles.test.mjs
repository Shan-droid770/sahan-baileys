import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { QueryIds, XWAPaths } from '../lib/Types/index.js'
import { executeWMexQuery } from '../lib/Socket/mex.js'
import {
    parseNewsletterMemberTier,
    parseNewsletterSubscriber,
    parseNewsletterSubscribers,
    classifyNewsletterSubscribers,
    findNewsletterMember,
    parseNewsletterAdminCount,
    parseNewsletterReference,
    buildMemberRoles
} from '../lib/Socket/newsletter.js'

// ── fixtures ───────────────────────────────────────────────────────────────
// Modelled on WhatsApp Web's WAWebMexFetchNewsletterSubscribersJob: `role` and
// `subscribe_time` live on the EDGE, `id` (LID), `pn` (phone jid) and
// `display_name` live on the NODE; entries without an `id` must be dropped.

const SUBSCRIBERS_PAYLOAD = {
    subscribers: {
        edges: [
            {
                node: { id: '111111111111111@lid', pn: '94771234567@s.whatsapp.net', display_name: 'Owner' },
                role: 'OWNER',
                subscribe_time: '1700000001'
            },
            { node: { id: '222222222222222@lid', display_name: 'Admin' }, role: 'ADMIN', subscribe_time: '1700000002' },
            { node: { id: '333333333333333@lid', display_name: 'Fan' }, role: 'SUBSCRIBER', subscribe_time: '1700000003' },
            { node: { display_name: 'ghost — no id' }, role: 'GUEST' },
            { node: { id: '444444444444444@lid', pn: '94770000004@s.whatsapp.net' }, role: 'guest' },
            { node: { id: '555555555555555@lid' }, role: 'superadmin' },
            { node: { id: '666666666666666@lid' } }
        ]
    }
}

// ── fake transport (same shape as newsletter-mex.test.mjs) ─────────────────

const okQuery = json => async () => ({
    tag: 'iq',
    attrs: { type: 'result' },
    content: [{ tag: 'result', attrs: {}, content: Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)) }]
})

describe('newsletter member tiers', () => {
    test('maps every known wire role (any case) to a tier', () => {
        assert.equal(parseNewsletterMemberTier('OWNER'), 'OWNER')
        assert.equal(parseNewsletterMemberTier('owner'), 'OWNER')
        assert.equal(parseNewsletterMemberTier('SUPERADMIN'), 'OWNER') // group-era alias
        assert.equal(parseNewsletterMemberTier('ADMIN'), 'ADMIN')
        assert.equal(parseNewsletterMemberTier('admin'), 'ADMIN')
        assert.equal(parseNewsletterMemberTier('GUEST'), 'MEMBER')
        assert.equal(parseNewsletterMemberTier('SUBSCRIBER'), 'MEMBER')
    })

    test('unknown or missing roles count as plain members (WA Web buckets them that way)', () => {
        assert.equal(parseNewsletterMemberTier(undefined), 'MEMBER')
        assert.equal(parseNewsletterMemberTier(null), 'MEMBER')
        assert.equal(parseNewsletterMemberTier('SOMETHING_NEW'), 'MEMBER')
    })
})

describe('newsletter subscriber parsing', () => {
    test('parses the WA Web edge shape: role on the edge, ids on the node', () => {
        const entry = parseNewsletterSubscriber(SUBSCRIBERS_PAYLOAD.subscribers.edges[0])
        assert.equal(entry.id, '111111111111111@lid')
        assert.equal(entry.pn, '94771234567@s.whatsapp.net')
        assert.equal(entry.displayName, 'Owner')
        assert.equal(entry.role, 'OWNER')
        assert.equal(entry.tier, 'OWNER')
        assert.equal(entry.subscribeTime, 1700000001)
        assert.equal(entry.raw, SUBSCRIBERS_PAYLOAD.subscribers.edges[0])
    })

    test('drops entries without an id (WA Web behaviour) and tolerates flat entries', () => {
        assert.equal(parseNewsletterSubscriber({ node: { display_name: 'x' }, role: 'GUEST' }), null)
        assert.equal(parseNewsletterSubscriber({ node: null, role: 'ADMIN' }), null)
        assert.equal(parseNewsletterSubscriber(null), null)
        const flat = parseNewsletterSubscriber({ id: '777777777777777@lid', role: 'ADMIN' })
        assert.equal(flat.id, '777777777777777@lid')
        assert.equal(flat.tier, 'ADMIN')
    })

    test('classifies role-less entries as MEMBER and keeps the raw role string', () => {
        const noRole = parseNewsletterSubscriber(SUBSCRIBERS_PAYLOAD.subscribers.edges[6])
        assert.equal(noRole.role, null)
        assert.equal(noRole.tier, 'MEMBER')
        const lower = parseNewsletterSubscriber(SUBSCRIBERS_PAYLOAD.subscribers.edges[4])
        assert.equal(lower.role, 'guest')
        assert.equal(lower.tier, 'MEMBER')
    })

    test('parses the full envelope and sorts owner/admins first (WA Web order)', () => {
        const entries = parseNewsletterSubscribers(SUBSCRIBERS_PAYLOAD)
        assert.equal(entries.length, 6) // 7 minus the id-less ghost
        assert.deepEqual(
            entries.map(entry => entry.tier),
            ['OWNER', 'OWNER', 'ADMIN', 'MEMBER', 'MEMBER', 'MEMBER']
        )
        assert.equal(entries[0].id, '111111111111111@lid')
    })

    test('accepts bare arrays / edges / subscribers-arrays, and never crashes on junk', () => {
        assert.equal(parseNewsletterSubscribers([]).length, 0)
        assert.equal(parseNewsletterSubscribers(SUBSCRIBERS_PAYLOAD.subscribers.edges).length, 6)
        assert.equal(parseNewsletterSubscribers({ edges: SUBSCRIBERS_PAYLOAD.subscribers.edges }).length, 6)
        assert.equal(parseNewsletterSubscribers({ subscribers: SUBSCRIBERS_PAYLOAD.subscribers.edges }).length, 6)
        assert.deepEqual(parseNewsletterSubscribers(null), [])
        assert.deepEqual(parseNewsletterSubscribers({ subscribers: { edges: null } }), [])
        assert.deepEqual(parseNewsletterSubscribers({ subscribers: 5 }), [])
        assert.deepEqual(parseNewsletterSubscribers('nonsense'), [])
    })
})

describe('newsletter member / admin / owner identification', () => {
    const entries = parseNewsletterSubscribers(SUBSCRIBERS_PAYLOAD)

    test('buckets into owner, admins and members', () => {
        const roles = classifyNewsletterSubscribers(entries)
        assert.equal(roles.owner.id, '111111111111111@lid')
        assert.deepEqual(
            roles.admins.map(entry => entry.id),
            ['222222222222222@lid']
        )
        assert.deepEqual(
            roles.members.map(entry => entry.id),
            // 555 carries the group-era SUPERADMIN alias → OWNER tier, so it is not a member
            ['333333333333333@lid', '444444444444444@lid', '666666666666666@lid']
        )
        assert.equal(roles.total, 6)
    })

    test('a SUPERADMIN-only list still identifies the owner', () => {
        const roles = classifyNewsletterSubscribers(parseNewsletterSubscribers([{ node: { id: '9@lid' }, role: 'SUPERADMIN' }]))
        assert.equal(roles.owner.id, '9@lid')
        assert.equal(roles.admins.length, 0)
    })

    test('finds one member by LID or by phone jid, tolerating device suffixes', () => {
        assert.equal(findNewsletterMember(entries, '111111111111111@lid')?.tier, 'OWNER')
        assert.equal(findNewsletterMember(entries, '222222222222222@lid:12')?.tier, 'ADMIN')
        assert.equal(findNewsletterMember(entries, '94771234567@s.whatsapp.net')?.tier, 'OWNER')
        assert.equal(findNewsletterMember(entries, '333333333333333@lid')?.tier, 'MEMBER')
        assert.equal(findNewsletterMember(entries, '999999999999999@lid'), null)
        assert.equal(findNewsletterMember(entries, ''), null)
        assert.equal(findNewsletterMember(entries, null), null)
        assert.equal(findNewsletterMember([], '111111111111111@lid'), null)
    })
})

describe('admin count parsing', () => {
    test('reads admin_count in every shape the server may send', () => {
        assert.equal(parseNewsletterAdminCount({ admin_count: 42 }), 42)
        assert.equal(parseNewsletterAdminCount({ adminCount: '7' }), 7)
        assert.equal(parseNewsletterAdminCount({ count: 3 }), 3)
        assert.equal(parseNewsletterAdminCount(9), 9)
    })

    test('returns null instead of undefined/garbage', () => {
        assert.equal(parseNewsletterAdminCount({}), null)
        assert.equal(parseNewsletterAdminCount({ admin_count: 'lots' }), null)
        assert.equal(parseNewsletterAdminCount(null), null)
        assert.equal(parseNewsletterAdminCount(undefined), null)
    })
})

describe('subscriber wire contract', () => {
    test('sends WA Web variables (input: { newsletter_id, count }) with QueryIds.SUBSCRIBERS', async () => {
        let sent
        const query = async node => {
            sent = node
            return okQuery({ data: { xwa2_newsletter_subscribers: SUBSCRIBERS_PAYLOAD } })()
        }
        const result = await executeWMexQuery(
            { input: { newsletter_id: '123@newsletter', count: 50 } },
            QueryIds.SUBSCRIBERS,
            XWAPaths.xwa2_newsletter_subscribers,
            query,
            () => 'MSG-1'
        )
        const request = JSON.parse(sent.content[0].content.toString())
        assert.deepEqual(request, { variables: { input: { newsletter_id: '123@newsletter', count: 50 } } })
        assert.equal(sent.content[0].attrs.query_id, QueryIds.SUBSCRIBERS)
        assert.equal(parseNewsletterSubscribers(result).length, 6)
    })

    test('newsletter.js keeps IDs centralized and retries the verified Baileys subscriber ID only on stale response', () => {
        const src = readFileSync(new URL('../lib/Socket/newsletter.js', import.meta.url), 'utf8')
        assert.match(src, /QueryIds\.SUBSCRIBERS/)
        assert.match(src, /queryId: '9783111038412085', variables: \{ newsletter_id: jid \}/)
        assert.doesNotMatch(src, /query_id:\s*['"]\d/, 'query IDs are passed through the shared w:mex helper')
    })
})

describe('channel reference resolution (id + name together)', () => {
    test('recognises a channel jid', () => {
        assert.deepEqual(parseNewsletterReference('120363414444444444@newsletter'), {
            type: 'jid',
            key: '120363414444444444@newsletter'
        })
    })

    test('recognises invite links — query/hash stripped, /channel/<code> located', () => {
        for (const link of [
            'https://whatsapp.com/channel/0029VaAbCdEf',
            'https://www.whatsapp.com/channel/0029VaAbCdEf',
            'whatsapp.com/channel/0029VaAbCdEf',
            'https://whatsapp.com/channel/0029VaAbCdEf?r=lc',
            'https://whatsapp.com/channel/0029VaAbCdEf#x',
            'https://whatsapp.com/channel/0029VaAbCdEf/'
        ]) {
            assert.deepEqual(parseNewsletterReference(link), { type: 'invite', key: '0029VaAbCdEf' }, link)
        }
    })

    test('recognises a bare invite code (trimmed)', () => {
        assert.deepEqual(parseNewsletterReference('  0029VaAbCdEf  '), { type: 'invite', key: '0029VaAbCdEf' })
    })

    test('rejects empty input and non-channel links with a 400 Boom', async () => {
        for (const bad of ['', '   ', null, undefined, 'https://chat.whatsapp.com/GroupCodeHere', 'https://whatsapp.com/']) {
            await assert.rejects(async () => parseNewsletterReference(bad), err => err.isBoom === true && err.output?.statusCode === 400, String(bad))
        }
    })
})

describe('member roles carry the channel identity', () => {
    const classification = classifyNewsletterSubscribers(parseNewsletterSubscribers(SUBSCRIBERS_PAYLOAD))

    test('resolves id and name together with the roles', () => {
        const meta = { id: '123@newsletter', name: 'News & Updates', subscribers: 900 }
        const roles = buildMemberRoles(classification, meta, 'fallback@newsletter')
        assert.equal(roles.id, '123@newsletter')
        assert.equal(roles.name, 'News & Updates')
        assert.equal(roles.total, 6)
        assert.equal(roles.owner.id, '111111111111111@lid')
        assert.equal(roles.admins.length, 1)
    })

    test('falls back to the raw jid with name null when metadata failed', () => {
        const roles = buildMemberRoles(classification, null, 'fallback@newsletter')
        assert.equal(roles.id, 'fallback@newsletter')
        assert.equal(roles.name, null)
        assert.equal(roles.total, 6)
    })

    test('an empty channel name becomes null, and nothing blows up on empty input', () => {
        assert.equal(buildMemberRoles(classification, { id: 'x@newsletter', name: '' }).name, null)
        const empty = buildMemberRoles(null, null, null)
        assert.deepEqual(empty, { id: null, name: null, owner: null, admins: [], members: [], total: 0 })
    })
})
