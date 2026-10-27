import { normalizeMessageContent } from './messages.js'

/**
 * WhatsApp Channel (@newsletter) media compatibility layer.
 *
 * Channels are not E2E chats: a post is encoded as a plaintext protobuf and
 * validated by the channel service, which rejects several shapes that are
 * perfectly valid for users and groups. Without this adaptation the send fails
 * with unhelpful errors ("GraphQL server error: Bad Request") or is silently
 * dropped — leaving developers to discover the matrix by trial and error.
 *
 * Adaptations (each can be disabled through `newsletterMediaCompat`):
 *
 *  - `voiceNoteAsAudio` (default true)
 *      ptt:true -> channel audio: ptt:false, ogg/opus mimetype, fileName and
 *      seconds. Voice notes are rejected/hidden on channels.
 *  - `stripThumbnail` (default true)
 *      drop the inline `jpegThumbnail` from image/video. Users and groups
 *      need it; the channel service refuses posts that carry one.
 *  - `dropGifPlayback` (default false)
 *      preserve the MP4-backed `gifPlayback` flag by default, matching the
 *      working Channel send path. Set true only as a compatibility fallback
 *      for a server/client that rejects GIF playback messages.
 *
 * `newsletterMediaCompat: false` disables everything (send the payload exactly
 * as built). Object form:
 *      newsletterMediaCompat: { stripThumbnail: false }
 */
export const DEFAULT_NEWSLETTER_MEDIA_COMPAT = {
    voiceNoteAsAudio: true,
    stripThumbnail: true,
    dropGifPlayback: false
}

/**
 * Mutates the message in place (normalizeMessageContent returns the inner
 * message by reference) and returns it, so it can be used inline:
 *   encodeNewsletterMessage(prepareChannelContent(patch(message), jid, opts))
 *
 * @param {object} content message content, possibly wrapped (viewOnce, etc.)
 * @param {string} jid channel jid (only used for logging)
 * @param {{ compat?: boolean | object, logger?: object }} [options]
 */
export const prepareChannelContent = (content, jid, options = {}) => {
    const { compat, logger } = options
    if (compat === false || !content || typeof content !== 'object') return content
    const opts = { ...DEFAULT_NEWSLETTER_MEDIA_COMPAT, ...(typeof compat === 'object' ? compat : {}) }
    const inner = normalizeMessageContent(content) ?? {}

    const audio = inner.audioMessage
    if (opts.voiceNoteAsAudio && audio?.ptt) {
        audio.ptt = false
        if (!audio.mimetype || !/ogg/i.test(audio.mimetype)) audio.mimetype = 'audio/ogg; codecs=opus'
        if (!audio.fileName) audio.fileName = 'audio.ogg'
        if (audio.seconds == null) audio.seconds = 1
        logger?.warn(
            { jid },
            'channel target: sending the voice note as regular channel audio (ptt:true is rejected by channels)'
        )
    }

    const media = inner.imageMessage || inner.videoMessage
    if (media) {
        if (opts.stripThumbnail && media.jpegThumbnail) {
            media.jpegThumbnail = null
            logger?.debug({ jid }, 'channel target: dropped the inline jpegThumbnail (rejected by the channel service)')
        }
        if (opts.dropGifPlayback && media.gifPlayback) {
            media.gifPlayback = false
            logger?.warn(
                { jid },
                'channel target: dropped gifPlayback because newsletterMediaCompat.dropGifPlayback is enabled; sending as normal video'
            )
        }
    }

    return content
}
