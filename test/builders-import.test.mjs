import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    AIRich,
    Album,
    Button,
    ButtonV2,
    ButtonV3,
    Carousel,
    CasileysBuilders,
    Contact,
    Location,
    MESSAGE_BUILDER_VERSION,
    NativeFlow,
    Poll
} from '../lib/Builders/index.js'

test('Casileys builder suite is importable and exposes its public builders', () => {
    for (const Builder of [AIRich, Album, Button, ButtonV2, ButtonV3, Carousel, CasileysBuilders, Contact, Location, NativeFlow, Poll]) {
        assert.equal(typeof Builder, 'function')
    }
    assert.equal(MESSAGE_BUILDER_VERSION, '5.0')
    assert.throws(() => new Button(), /Socket is required/)
})
