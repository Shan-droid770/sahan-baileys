import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
    newsletterAdminChannels,
    newsletterFetchAll,
    newsletterFetchAllSubscribe,
    newsletterMemberRole,
    newsletterMemberRoles,
    newsletterMetadata,
    newsletterResolve,
    newsletterSubscribers
} from '../lib/Pro/newsletter.js'

describe('package-level newsletter API wrappers', () => {
    test('fetch-all aliases use the subscribed socket surface', async () => {
        const channels = [{ id: 'admin@newsletter', viewer_metadata: { role: 'ADMIN' } }]
        const sock = { newsletterSubscribed: async () => channels }
        assert.deepEqual(await newsletterFetchAll(sock), channels)
        assert.deepEqual(await newsletterFetchAllSubscribe(sock), channels)
    })

    test('admin picker accepts only explicit OWNER/ADMIN roles when using its safe fallback', async () => {
        const sock = {
            newsletterSubscribed: async () => [
                { id: 'owner@newsletter', viewer_metadata: { role: 'OWNER' } },
                { id: 'admin@newsletter', role: 'ADMIN' },
                { id: 'member@newsletter', viewer_metadata: { role: 'SUBSCRIBER' } },
                { id: 'unknown@newsletter' }
            ]
        }
        const result = await newsletterAdminChannels(sock)
        assert.deepEqual(result.map(channel => channel.id), ['owner@newsletter', 'admin@newsletter'])
    })

    test('admin picker delegates to the socket authorization filter when available', async () => {
        const verified = [{ id: 'verified-admin@newsletter', role: 'ADMIN' }]
        const sock = { newsletterAdminChannels: async () => verified }
        assert.deepEqual(await newsletterAdminChannels(sock), verified)
    })

    test('metadata, subscriber, resolver, and role wrappers preserve arguments and results', async () => {
        const calls = []
        const sock = Object.fromEntries([
            ['newsletterResolve', { id: 'resolved@newsletter' }],
            ['newsletterMetadata', { id: 'metadata@newsletter' }],
            ['newsletterSubscribers', [{ id: 'member@lid', tier: 'ADMIN' }]],
            ['newsletterMemberRole', 'ADMIN'],
            ['newsletterMemberRoles', { id: 'roles@newsletter', admins: [] }]
        ].map(([key, result]) => [key, async (...args) => { calls.push([key, args]); return result }]))

        assert.deepEqual(await newsletterResolve(sock, 'https://wa.me/channel/example'), { id: 'resolved@newsletter' })
        assert.deepEqual(await newsletterMetadata(sock, 'jid', 'channel@newsletter'), { id: 'metadata@newsletter' })
        assert.deepEqual(await newsletterSubscribers(sock, 'channel@newsletter', 100), [{ id: 'member@lid', tier: 'ADMIN' }])
        assert.equal(await newsletterMemberRole(sock, 'channel@newsletter', 'member@lid'), 'ADMIN')
        assert.deepEqual(await newsletterMemberRoles(sock, 'channel@newsletter', 100), { id: 'roles@newsletter', admins: [] })
        assert.deepEqual(calls.map(([name]) => name), [
            'newsletterResolve', 'newsletterMetadata', 'newsletterSubscribers', 'newsletterMemberRole', 'newsletterMemberRoles'
        ])
    })

    test('root package exports all channel discovery and role wrappers', () => {
        const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
        for (const name of [
            'newsletterFetchAllSubscribe', 'newsletterFetchAll', 'newsletterAdminChannels',
            'newsletterResolve', 'newsletterMetadata', 'newsletterSubscribers',
            'newsletterMemberRole', 'newsletterMemberRoles'
        ]) {
            assert.match(source, new RegExp(`export const ${name}\\s*=`), `${name} must be importable from the package root`)
        }
    })
})
