/**
 * Regression tests for the newsletter / w:mex layer and channel sends.
 *
 * These exist because of a real bug class: every newsletter file had its own
 * copy of the w:mex query-id table, one copy was missing SUBSCRIBED, so
 * `query_id: undefined` went to the server and the answer came back as a
 * binary/legacy body — surfacing as "… is not valid JSON" deep inside
 * JSON.parse. The fixtures below are the shapes WhatsApp actually returns,
 * so table rot (or a parser that only works on the happy path) fails CI here
 * instead of in a user's bot.
 *
 * Run: node --test test/newsletter-mex.test.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

import { QueryIds, XWAPaths, resolveQueryId } from '../lib/Types/index.js'
import { executeWMexQuery } from '../lib/Socket/mex.js'
import {
    extractNewsletterMetadata,
    filterNewsletterAdminChannels,
    resolveNewsletterAdminChannels,
    parseNewsletterMetadata,
    parseNewsletterSubscriptions
} from '../lib/Socket/newsletter.js'
import { prepareChannelContent } from '../lib/Utils/newsletter-media.js'
import { DEFAULT_CONNECTION_CONFIG } from '../lib/Defaults/index.js'

const FAKE_LOGGER = { child() { return this }, info() {}, debug() {}, warn() {}, error() {} }

// ── fixtures: real GraphQL envelopes ────────────────────────────────────────

const METADATA_PAYLOAD = {
    id: '120363414000000001@newsletter',
    state: { type: 'ACTIVE' },
    thread_metadata: {
        creation_time: '1690000000',
        name: { id: 'n1', text: 'Aysu Bots', update_time: '1690000001' },
        description: { id: 'd1', text: 'everything about bots', update_time: '1690000002' },
        subscribers_count: '12345',
        verification: 'UNVERIFIED',
        invite: '0029VaAbCdEf',
        handle: 'aysubots',
        picture: { id: 'p1', direct_path: '/m1/v/t24/abc', type: 'IMAGE' },
        preview: { id: 'p2', direct_path: '/m1/v/t24/preview', type: 'IMAGE' },
        settings: { reaction_codes: { value: 'ALL' } }
    },
    viewer_metadata: { role: 'ADMIN', mute: 'OFF' }
}

/** A channel with no description, no picture and no settings block. */
const MINIMAL_PAYLOAD = {
    id: '120363400000000002@newsletter',
    state: { type: 'ACTIVE' },
    thread_metadata: {
        creation_time: '1690000000',
        name: { id: 'n2', text: 'bare channel', update_time: '1690000001' },
        subscribers_count: '1',
        verification: 'UNVERIFIED'
    }
}

/** What the server sends for a deleted / unknown channel. */
const NOT_FOUND_PAYLOAD = { id: null, state: null, thread_metadata: null }

const SUBSCRIBED_PAYLOAD = [METADATA_PAYLOAD, NOT_FOUND_PAYLOAD, null, { id: '' }]

// ── fake transport ──────────────────────────────────────────────────────────

const okQuery = json => async () => ({
    tag: 'iq',
    attrs: { type: 'result' },
    content: [{ tag: 'result', attrs: {}, content: Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)) }]
})

const run = (payload, dataPath = XWAPaths.xwa2_newsletter_metadata, queryId = QueryIds.METADATA, overrides) =>
    executeWMexQuery({}, queryId, dataPath, okQuery(payload), () => 'MSG-1', overrides)

describe('w:mex layer', () => {
    test('single source of truth: Socket/newsletter.js has no local query-id table', () => {
        const src = readFileSync(new URL('../lib/Socket/newsletter.js', import.meta.url), 'utf8')
        assert.doesNotMatch(src, /const\s+QueryIds\s*=\s*\{/, 'a local QueryIds table shadows Types/Mex.js')
        assert.match(src, /from '\.\.\/Types\/index\.js'/, 'newsletter.js must import the shared constants')
    })

    test('JOB_MUTATION exists in the shared table (it used to live only in the socket)', () => {
        assert.equal(QueryIds.JOB_MUTATION, '7150902998257522')
    })

    test('unwraps data at the requested path', async () => {
        const result = await run({ data: { xwa2_newsletter: METADATA_PAYLOAD } })
        assert.deepEqual(result, METADATA_PAYLOAD)
    })

    test('non-JSON body is diagnosed without exposing its contents or falsely asserting stale ID', async () => {
        const privateMarker = 'private-channel-name-should-not-leak'
        await assert.rejects(
            () => run(privateMarker),
            err => {
                assert.equal(err.isBoom, true)
                assert.equal(err.output.statusCode, 400)
                assert.match(err.message, /non-JSON response/)
                assert.match(err.message, /compressed\/legacy response or a stale query id/)
                assert.doesNotMatch(err.message, new RegExp(privateMarker))
                assert.equal(err.data.responseBytes, Buffer.byteLength(privateMarker))
                assert.equal(err.data.preview, undefined)
                return true
            }
        )
    })

    test('decodes gzip-compressed w:mex JSON response bodies', async () => {
        const payload = { data: { xwa2_newsletter: METADATA_PAYLOAD } }
        const response = await executeWMexQuery(
            {}, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata,
            async () => ({ tag: 'iq', attrs: {}, content: [{ tag: 'result', attrs: {}, content: gzipSync(Buffer.from(JSON.stringify(payload))) }] }),
            () => 'MSG-GZIP'
        )
        assert.deepEqual(response, METADATA_PAYLOAD)
    })

    test('GraphQL error array becomes a Boom with the server error code', async () => {
        await assert.rejects(
            () => run({ errors: [{ message: 'Bad Request', extensions: { error_code: 400 } }] }),
            err => {
                assert.equal(err.isBoom, true)
                assert.match(err.message, /GraphQL server error \(code 400\)/)
                assert.equal(err.output.statusCode, 400)
                assert.equal(err.data.errorCode, 400)
                return true
            }
        )
    })

    test('missing data node reports which query failed', async () => {
        await assert.rejects(() => run({ data: {} }), err => {
            assert.equal(err.isBoom, true)
            assert.match(err.message, /unexpected response structure/)
            assert.match(err.message, new RegExp(QueryIds.METADATA))
            return true
        })
    })

    test('mexQueryIdOverrides hot-patches a rotated id (by enum name)', async () => {
        let sentId
        const query = async node => {
            sentId = node.content[0].attrs.query_id
            return okQuery({ data: { xwa2_newsletter: METADATA_PAYLOAD } })()
        }
        await executeWMexQuery({}, 'METADATA', XWAPaths.xwa2_newsletter_metadata, query, () => 'MSG', {
            METADATA: '1111111111111111'
        })
        assert.equal(sentId, '1111111111111111')
        assert.equal(resolveQueryId('METADATA'), QueryIds.METADATA)
        assert.equal(resolveQueryId('METADATA', { METADATA: '99' }), '99')
    })

    test('mexQueryIdOverrides applies to the numeric call pattern used by the sockets', async () => {
        // Socket code passes QueryIds.METADATA (already the numeric id), never
        // the string 'METADATA' — the documented { METADATA: '…' } override
        // must still win. Regression: it used to be silently ignored.
        let sentId
        const query = async node => {
            sentId = node.content[0].attrs.query_id
            return okQuery({ data: { xwa2_newsletter: METADATA_PAYLOAD } })()
        }
        await executeWMexQuery({}, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata, query, () => 'MSG', {
            METADATA: '2222222222222222'
        })
        assert.equal(sentId, '2222222222222222')
        assert.equal(resolveQueryId(QueryIds.METADATA, { METADATA: '99' }), '99')
        assert.equal(resolveQueryId(QueryIds.METADATA, { [QueryIds.METADATA]: '98' }), '98')
        assert.equal(resolveQueryId(QueryIds.METADATA), QueryIds.METADATA)
    })

    test('an unknown enum name fails locally instead of reaching the server as-is', async () => {
        let called = false
        await assert.rejects(
            () =>
                executeWMexQuery({}, 'METADTA', XWAPaths.xwa2_newsletter_metadata, async () => {
                    called = true
                }, () => 'MSG'),
            /Missing w:mex query id/
        )
        assert.equal(called, false)
    })

    test('a missing id fails locally instead of sending query_id:undefined', async () => {
        let called = false
        await assert.rejects(
            () =>
                executeWMexQuery({}, undefined, XWAPaths.xwa2_newsletter_subscribed, async () => {
                    called = true
                }, () => 'MSG'),
            /Missing w:mex query id/
        )
        assert.equal(called, false, 'nothing may be put on the wire without a query id')
    })
})

describe('newsletter metadata parsing', () => {
    test('parses subscribed data arrays, GraphQL edge wrappers, and keeps viewer roles', () => {
        const direct = parseNewsletterSubscriptions(SUBSCRIBED_PAYLOAD)
        assert.equal(direct.length, 1)
        assert.equal(direct[0].viewer_metadata.role, 'ADMIN')
        const wrapped = parseNewsletterSubscriptions({
            data: { xwa2_newsletter_subscribed: [{ node: METADATA_PAYLOAD, role: 'OWNER' }] }
        })
        assert.equal(wrapped.length, 1)
        assert.equal(wrapped[0].viewer_metadata.role, 'OWNER')
        assert.equal(parseNewsletterSubscriptions({ unrelated: [] }).length, 0)
    })

    test('parses subscribed GraphQL edge wrappers and keeps the viewer role', () => {
        const parsed = parseNewsletterMetadata({ node: METADATA_PAYLOAD, role: 'OWNER' })
        assert.equal(parsed?.id, METADATA_PAYLOAD.id)
        assert.equal(parsed?.name, 'Aysu Bots')
        assert.equal(parsed?.viewer_metadata?.role, 'OWNER')
    })

    test('owner/admin filter fails closed and sorts owners before admins', () => {
        const filtered = filterNewsletterAdminChannels([
            { id: 'sub', name: 'Subscriber', role: 'SUBSCRIBER' },
            { id: 'admin', name: 'Admin', viewer_metadata: { role: 'ADMIN' } },
            { id: 'unknown', name: 'Unknown' },
            { id: 'owner', name: 'Owner', role: 'OWNER' },
            { id: 'guest', role: 'GUEST' }
        ])
        assert.deepEqual(filtered.map(channel => channel.id), ['owner', 'admin'])
    })

    test('full payload', () => {
        assert.deepEqual(parseNewsletterMetadata(METADATA_PAYLOAD), {
            id: '120363414000000001@newsletter',
            state: 'ACTIVE',
            creation_time: 1690000000,
            name: 'Aysu Bots',
            nameTime: 1690000001,
            description: 'everything about bots',
            descriptionTime: 1690000002,
            invite: '0029VaAbCdEf',
            handle: 'aysubots',
            picture: '/m1/v/t24/abc',
            preview: '/m1/v/t24/preview',
            reaction_codes: 'ALL',
            subscribers: 12345,
            verification: 'UNVERIFIED',
            viewer_metadata: { role: 'ADMIN', mute: 'OFF' }
        })
    })

    test('channel without description/picture/settings does not throw (was a TypeError)', () => {
        const meta = parseNewsletterMetadata(MINIMAL_PAYLOAD)
        assert.equal(meta.name, 'bare channel')
        assert.equal(meta.description, '')
        assert.equal(meta.picture, null)
        assert.equal(meta.reaction_codes, null)
        assert.equal(meta.viewer_metadata, null)
    })

    test('unknown channel (id: null) is a 404, not a crash', () => {
        assert.equal(parseNewsletterMetadata(NOT_FOUND_PAYLOAD), null)
        assert.throws(
            () => extractNewsletterMetadata(NOT_FOUND_PAYLOAD),
            err => {
                assert.equal(err.isBoom, true)
                assert.equal(err.output.statusCode, 404)
                assert.match(err.message, /Channel not found/)
                return true
            }
        )
    })

    test('still accepts a legacy binary <iq> node', () => {
        const node = {
            tag: 'iq',
            attrs: {},
            content: [
                { tag: 'result', attrs: {}, content: Buffer.from(JSON.stringify({ data: { xwa2_newsletter: METADATA_PAYLOAD } })) }
            ]
        }
        assert.equal(extractNewsletterMetadata(node).id, METADATA_PAYLOAD.id)
    })
})

describe('newsletterSubscribed payload', () => {
    test('skips null / id-less entries and keeps viewer_metadata (role)', async () => {
        const result = await run(
            { data: { xwa2_newsletter_subscribed: SUBSCRIBED_PAYLOAD } },
            XWAPaths.xwa2_newsletter_subscribed,
            QueryIds.SUBSCRIBED
        )
        const parsed = result.map(parseNewsletterMetadata).filter(Boolean)
        assert.equal(parsed.length, 1)
        assert.equal(parsed[0].id, METADATA_PAYLOAD.id)
        assert.equal(parsed[0].viewer_metadata.role, 'ADMIN')
    })
})

describe('strict subscribed-channel admin resolution', () => {
    test('uses roles already present and avoids redundant metadata/subscriber queries', async () => {
        const calls = []
        const result = await resolveNewsletterAdminChannels([
            { id: 'a@newsletter', viewer_metadata: { role: 'ADMIN' } },
            { id: 'b@newsletter', viewer_metadata: { role: 'SUBSCRIBER' } },
            { id: 'c@newsletter' },
            { id: 'd@newsletter', viewer_metadata: { role: 'UNRECOGNIZED' } }
        ], {
            ownIds: ['self@lid'],
            fetchMetadata: async jid => {
                calls.push(['metadata', jid])
                return { id: jid, name: jid, viewer_metadata: { role: 'OWNER' } }
            },
            fetchSubscribers: async jid => {
                calls.push(['subscribers', jid])
                return []
            }
        })

        assert.deepEqual(result.map(channel => channel.id), ['c@newsletter', 'a@newsletter'])
        assert.deepEqual(calls, [['metadata', 'c@newsletter']])
    })

    test('falls back to a matching own member role only when viewer role is absent', async () => {
        const calls = []
        const result = await resolveNewsletterAdminChannels([{ id: 'missing-role@newsletter' }], {
            ownIds: ['self@lid'],
            fetchMetadata: async jid => ({ id: jid }),
            fetchSubscribers: async (jid, count) => {
                calls.push([jid, count])
                return [{ id: 'self@lid', tier: 'ADMIN' }]
            }
        })
        assert.equal(result[0].role, 'ADMIN')
        assert.deepEqual(calls, [['missing-role@newsletter', 100]])
    })
})

describe('newsletter socket source contracts', () => {
    const src = readFileSync(new URL('../lib/Socket/newsletter.js', import.meta.url), 'utf8')

    test('admin-channel picker verifies roles and reuses subscribed viewer_metadata', () => {
        assert.match(src, /const fetchAdminChannels = async \(\) =>/)
        assert.match(src, /resolveNewsletterAdminChannels\(channels, \{/)
        assert.match(src, /fetchMetadata: jid => fetchMetadata\('jid', jid\)/)
        assert.match(src, /if \(!role && typeof fetchMetadata === 'function'\)/)
        assert.match(src, /if \(role \|\| !ownIds\.length \|\| typeof fetchSubscribers !== 'function'\) continue/)
        assert.match(src, /newsletterAdminChannels: fetchAdminChannels/)
        assert.match(src, /newsletterFetchAll: fetchSubscribed/)
        assert.match(src, /newsletterFetchAllSubscribe: fetchSubscribed/)
        assert.match(src, /newsletterGetInviteInfo: async reference =>/)
    })

    test('view_role is only sent when the caller passes a role', () => {
        assert.match(src, /if \(role\) input\.view_role = role/)
        assert.doesNotMatch(src, /view_role: role \|\| 'GUEST'/)
    })

    test('subscription lookup uses the verified single query ID without retries', () => {
        assert.match(src, /mexQuery\(\{\}, QueryIds\.SUBSCRIBED, XWAPaths\.xwa2_newsletter_subscribed\)/)
        assert.match(src, /Date\.now\(\) - subscribedRequestAt < 750/)
        assert.doesNotMatch(src, /QueryIds\.SUBSCRIBED[^\n]*8621797084555037/)
        assert.match(src, /\['9779843322044422'\]/)
        assert.match(src, /queryId: '9783111038412085', variables: \{ newsletter_id: jid \}/)
    })

    test('every channel op goes through the shared mex helper', () => {
        assert.doesNotMatch(src, /newsletterWMexQuery/, 'the ad-hoc w:mex helper must not come back')
        assert.match(src, /import \{ executeWMexQuery \} from '\.\/mex\.js'/)
    })

    test('subscribed has the fork-compatible alias and uses the shared ids', () => {
        assert.match(src, /newsletterFetchAllSubscribe/)
        assert.match(src, /QueryIds\.SUBSCRIBED/)
        assert.match(src, /XWAPaths\.xwa2_newsletter_subscribed/)
        assert.match(src, /newsletterSubscribers/)
    })
})

describe('channel media compatibility (B1–B3)', () => {
    const logger = { ...FAKE_LOGGER, warn() {} }

    test('voice note becomes regular channel audio', () => {
        const content = {
            audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', audioMessage: Buffer.alloc(0) }
        }
        prepareChannelContent(content, '120363@newsletter', { logger })
        assert.equal(content.audioMessage.ptt, false)
        assert.equal(content.audioMessage.mimetype, 'audio/ogg; codecs=opus')
        assert.equal(content.audioMessage.fileName, 'audio.ogg')
        assert.equal(content.audioMessage.seconds, 1)
    })

    test('inline jpegThumbnail is stripped from image/video posts', () => {
        const content = { imageMessage: { jpegThumbnail: Buffer.from([1, 2, 3]) } }
        prepareChannelContent(content, '120363@newsletter', { logger })
        assert.equal(content.imageMessage.jpegThumbnail, null)
    })

    test('gifPlayback is preserved for channel posts by default; legacy stripping is opt-in', () => {
        const content = { videoMessage: { gifPlayback: true, jpegThumbnail: Buffer.from([1]) } }
        prepareChannelContent(content, '120363@newsletter', { logger })
        assert.equal(content.videoMessage.gifPlayback, true)
        assert.equal(content.videoMessage.jpegThumbnail, null)

        const compatibilityFallback = { videoMessage: { gifPlayback: true } }
        prepareChannelContent(compatibilityFallback, '120363@newsletter', {
            compat: { dropGifPlayback: true }, logger
        })
        assert.equal(compatibilityFallback.videoMessage.gifPlayback, false)
    })

    test('wrapped messages (viewOnce) are adapted in place', () => {
        const content = { viewOnceMessage: { message: { imageMessage: { jpegThumbnail: Buffer.from([1]) } } } }
        prepareChannelContent(content, '120363@newsletter', { logger })
        assert.equal(content.viewOnceMessage.message.imageMessage.jpegThumbnail, null)
    })

    test('newsletterMediaCompat:false leaves the payload untouched', () => {
        const content = { audioMessage: { ptt: true } }
        prepareChannelContent(content, '120363@newsletter', { compat: false, logger })
        assert.equal(content.audioMessage.ptt, true)
    })

    test('per-flag opt-out', () => {
        const content = { imageMessage: { jpegThumbnail: Buffer.from([1]) } }
        prepareChannelContent(content, '120363@newsletter', { compat: { stripThumbnail: false }, logger })
        assert.deepEqual(content.imageMessage.jpegThumbnail, Buffer.from([1]))
    })
})

describe('bot-friendly defaults (D1/D2)', () => {
    test('aiLabel is opt-in', () => {
        assert.equal(DEFAULT_CONNECTION_CONFIG.aiLabel, false)
    })

    test('defaults match the README quick-start (no forced presence, no full history)', () => {
        assert.equal(DEFAULT_CONNECTION_CONFIG.syncFullHistory, false)
        assert.equal(DEFAULT_CONNECTION_CONFIG.markOnlineOnConnect, false)
    })
})
