import * as boom_1 from '@hapi/boom'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import * as WABinary_1 from '../WABinary/index.js'
import { resolveQueryId } from '../Types/Mex.js'

const MAX_MEX_RESPONSE_BYTES = 16 * 1024 * 1024

/**
 * Decode a w:mex result body as JSON. WhatsApp can return compressed JSON
 * bodies; never include body text in thrown errors because it can contain
 * private channel/account data.
 */
export const decodeWMexResponse = (content, queryId) => {
    const input = Buffer.isBuffer(content)
        ? content
        : content instanceof Uint8Array
            ? Buffer.from(content)
            : typeof content === 'string'
                ? Buffer.from(content, 'utf8')
                : Buffer.alloc(0)
    const attempts = [{ format: 'plain', buffer: input }]
    const decompressionErrors = []

    if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
        try { attempts.push({ format: 'gzip', buffer: gunzipSync(input, { maxOutputLength: MAX_MEX_RESPONSE_BYTES }) }) }
        catch { decompressionErrors.push('gzip') }
    } else if (input.length >= 2 && input[0] === 0x78) {
        try { attempts.push({ format: 'zlib', buffer: inflateSync(input, { maxOutputLength: MAX_MEX_RESPONSE_BYTES }) }) }
        catch { decompressionErrors.push('zlib') }
    }

    // Some deployments negotiate Brotli at the transport layer. Try it only
    // after plain/gzip/zlib JSON parsing fails, and bound expanded size.
    const parseJsonText = text => {
        const normalized = text.replace(/^\uFEFF/, '').trim()
        if (!normalized) return undefined
        try { return JSON.parse(normalized) } catch { /* try an enveloped JSON body */ }
        const firstObject = normalized.indexOf('{')
        const lastObject = normalized.lastIndexOf('}')
        if (firstObject >= 0 && lastObject > firstObject) {
            try { return JSON.parse(normalized.slice(firstObject, lastObject + 1)) } catch { /* not JSON */ }
        }
        const firstArray = normalized.indexOf('[')
        const lastArray = normalized.lastIndexOf(']')
        if (firstArray >= 0 && lastArray > firstArray) {
            try { return JSON.parse(normalized.slice(firstArray, lastArray + 1)) } catch { /* not JSON */ }
        }
        return undefined
    }

    for (const attempt of attempts) {
        const parsed = parseJsonText(attempt.buffer.toString('utf8'))
        if (parsed !== undefined) return { data: parsed, format: attempt.format }
    }
    if (input.length) {
        // Raw DEFLATE has no zlib header and is used by some MEX transports.
        // This is attempted only after parsing the body as plain JSON fails.
        try {
            const decoded = inflateRawSync(input, { maxOutputLength: MAX_MEX_RESPONSE_BYTES })
            const parsed = parseJsonText(decoded.toString('utf8'))
            if (parsed !== undefined) return { data: parsed, format: 'deflate-raw' }
            decompressionErrors.push('deflate-raw-json')
        } catch {
            decompressionErrors.push('deflate-raw')
        }
        try {
            const decoded = brotliDecompressSync(input, { maxOutputLength: MAX_MEX_RESPONSE_BYTES })
            const parsed = parseJsonText(decoded.toString('utf8'))
            if (parsed !== undefined) return { data: parsed, format: 'brotli' }
            decompressionErrors.push('brotli-json')
        } catch {
            decompressionErrors.push('brotli')
        }
    }

    const format = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b
        ? 'gzip (decode failed)'
        : input.length >= 2 && input[0] === 0x78
            ? 'zlib (decode failed)'
            : 'plain-or-unknown-binary'
    throw new boom_1.Boom(
        `w:mex query ${queryId} returned a non-JSON response (${format}, ${input.length} bytes). ` +
            'This can be a compressed, legacy, binary, or upstream throttling response; response content was omitted for privacy.',
        {
            statusCode: 400,
            data: {
                queryId,
                responseBytes: input.length,
                format,
                prefixHex: input.subarray(0, 8).toString('hex'),
                decompressionErrors
            }
        }
    )
}

/**
 * Send a raw w:mex IQ.
 *
 * `queryId` may be a QueryIds value or an enum name (`'METADATA'`); it is
 * passed through `resolveQueryId` so `mexQueryIdOverrides` from the socket
 * config can hot-patch rotated ids without forking the library.
 */
export const wMexQuery = (variables, queryId, query, generateMessageTag, overrides) => {
    const resolvedQueryId = resolveQueryId(queryId, overrides)
    if (!resolvedQueryId || !/^\d+$/.test(String(resolvedQueryId))) {
        throw new boom_1.Boom(`Missing w:mex query id for "${queryId}" — pass a numeric ID through mexQueryIdOverrides`, { statusCode: 400 })
    }
    return query({
        tag: 'iq',
        attrs: {
            id: generateMessageTag(),
            type: 'get',
            to: WABinary_1.S_WHATSAPP_NET,
            xmlns: 'w:mex'
        },
        content: [
            {
                tag: 'query',
                attrs: { query_id: resolvedQueryId },
                content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
            }
        ]
    })
}

/**
 * Run a w:mex query and pull `data[dataPath]` out of the response envelope.
 * Unexpected and compressed bodies are reported without logging their content.
 */
export const executeWMexQuery = async (variables, queryId, dataPath, query, generateMessageTag, overrides) => {
    const resolvedQueryId = resolveQueryId(queryId, overrides)
    const result = await wMexQuery(variables, queryId, query, generateMessageTag, overrides)
    const child = (0, WABinary_1.getBinaryNodeChild)(result, 'result')
    if (child?.content != null) {
        const { data, format } = decodeWMexResponse(child.content, resolvedQueryId)
        if (data?.errors && data.errors.length > 0) {
            const errorCode = data.errors[0]?.extensions?.error_code || 400
            const safeError = new boom_1.Boom(`GraphQL server error (code ${errorCode}) for w:mex query ${resolvedQueryId}`, {
                statusCode: errorCode,
                data: { queryId: resolvedQueryId, errorCode }
            })
            throw safeError
        }
        const response = dataPath ? data?.data?.[dataPath] : data?.data
        if (typeof response !== 'undefined') return response
        const action = (dataPath || '').startsWith('xwa2_')
            ? dataPath.substring(5).replace(/_/g, ' ')
            : dataPath?.replace(/_/g, ' ')
        throw new boom_1.Boom(
            `Failed to ${action || 'run the w:mex query'}: unexpected response structure; JSON lacked the expected data path (query id ${resolvedQueryId}, ${format}).`,
            { statusCode: 400, data: { queryId: resolvedQueryId, dataPath, responseFormat: format } }
        )
    }
    const action = (dataPath || '').startsWith('xwa2_')
        ? dataPath.substring(5).replace(/_/g, ' ')
        : dataPath?.replace(/_/g, ' ')
    throw new boom_1.Boom(
        `Failed to ${action || 'run the w:mex query'}: response had no result body (query id ${resolvedQueryId}).`,
        { statusCode: 400, data: { queryId: resolvedQueryId, hasResultNode: !!child } }
    )
}
