import { randomBytes } from 'crypto'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { unixTimestampSeconds } from '../Utils/generics.js'

// some extra useful utilities
export const getBinaryNodeChildren = (node, childTag) => {
    if (Array.isArray(node?.content)) {
        return node.content.filter(item => item.tag === childTag)
    }
    return []
}

export const getAllBinaryNodeChildren = ({ content }) => {
    if (Array.isArray(content)) {
        return content
    }
    return []
}

export const getBinaryNodeChild = (node, childTag) => {
    if (Array.isArray(node?.content)) {
        return node?.content.find(item => item.tag === childTag)
    }
}

export const getBinaryNodeChildBuffer = (node, childTag) => {
    const child = getBinaryNodeChild(node, childTag)?.content
    if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
        return child
    }
}

export const getBinaryNodeChildString = (node, childTag) => {
    const child = getBinaryNodeChild(node, childTag)?.content
    if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
        return Buffer.from(child).toString('utf-8')
    }
    else if (typeof child === 'string') {
        return child
    }
}

export const getBinaryNodeChildUInt = (node, childTag, length) => {
    const buff = getBinaryNodeChildBuffer(node, childTag)
    if (buff) {
        return bufferToUInt(buff, length)
    }
}

export const assertNodeErrorFree = (node) => {
    const errNode = getBinaryNodeChild(node, 'error')
    if (errNode) {
        throw new Boom(errNode.attrs.text || 'Unknown error', { data: +errNode.attrs.code })
    }
}

export const reduceBinaryNodeToDictionary = (node, tag) => {
    const nodes = getBinaryNodeChildren(node, tag)
    const dict = nodes.reduce((dict, { attrs }) => {
        dict[attrs.name || attrs.config_code] = attrs.value || attrs.config_value
        return dict
    }, {})
    return dict
}

export const getBinaryNodeMessages = ({ content }) => {
    const msgs = []
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item.tag === 'message') {
                msgs.push(proto.WebMessageInfo.decode(item.content))
            }
        }
    }
    return msgs
}

function bufferToUInt(e, t) {
    let a = 0;
    for (let i = 0; i < t; i++) {
        a = 256 * a + e[i];
    }
    return a;
}

const tabs = (n) => '\t'.repeat(n)

export function binaryNodeToString(node, i = 0) {
    if (!node) {
        return node;
    }
    if (typeof node === 'string') {
        return tabs(i) + node;
    }
    if (node instanceof Uint8Array) {
        return tabs(i) + Buffer.from(node).toString('hex');
    }
    if (Array.isArray(node)) {
        return node.map((x) => tabs(i + 1) + binaryNodeToString(x, i + 1)).join('\n');
    }
    const children = binaryNodeToString(node.content, i + 1);
    const tag = `<${node.tag} ${Object.entries(node.attrs || {})
       .filter(([, v]) => v!== undefined)
       .map(([k, v]) => `${k}='${v}'`)
       .join(' ')}`;
    const content = children? `>\n${children}\n${tabs(i)}</${node.tag}>` : '/>';
    return tag + content;
}

export const getBinaryNodeFilter = (node) => {
   if (!Array.isArray(node)) return false

   return node.some(item =>
      ['native_flow'].includes(item?.content?.[0]?.content?.[0]?.tag) ||
      ['interactive', 'buttons', 'list'].includes(item?.content?.[0]?.tag) ||
      ['hsm', 'biz'].includes(item?.tag) ||
      ['bot'].includes(item?.tag) && item?.attrs?.biz_bot === '1'
   )
}

export const getAdditionalNode = (name) => {
   if (name) name = name.toLowerCase()
   const ts = unixTimestampSeconds(new Date()) - 77980457

   const order_response_name = {
      review_and_pay: 'order_details',
      review_order: 'order_status',
      order_status: 'order_status',
      payment_info: 'payment_info',
      payment_status: 'payment_status',
      payment_method: 'payment_method',
      catalog_message: 'catalog_message',
   }

   const flow_name = {
      cta_catalog: 'cta_catalog',
      mpm: 'mpm',
      call_request: 'call_permission_request',
      view_catalog: 'automated_greeting_message_view_catalog',
      wa_pay_detail: 'wa_payment_transaction_details',
      send_location: 'send_location',
      payment_key_info: 'payment_key_info'
   }

   if(order_response_name[name]) {
       return [{
           tag: 'biz',
           attrs: {
               native_flow_name: order_response_name[name]
           },
           content: []
       }]
   } else if (flow_name[name] || name === 'interactive' || name === 'buttons') {
       return [{
           tag: 'biz',
           attrs: {
               actual_actors: '2',
               host_storage: '2',
               privacy_mode_ts: `${ts}`
           },
           content: [{
               tag: 'engagement',
               attrs: {
                   customer_service_state: 'open',
                   conversation_state: 'open'
               }
           }, {
               tag: 'interactive',
               attrs: {
                   type: 'native_flow',
                   v: '1'
               },
               content: [{
                   tag: 'native_flow',
                   attrs: {
                       v: '9',
                       name: flow_name[name]?? 'mixed',
                   },
                       content: []
                   }]
               }]
           }]
   } else {
         return [{
         tag: 'biz',
         attrs: {
            actual_actors: '2',
            host_storage: '2',
            privacy_mode_ts: `${ts}`
         },
         content: [{
            tag: 'engagement',
            attrs: {
               customer_service_state: 'open',
               conversation_state: 'open'
            }
         }]
      }]
   }
}
export const getBinaryFilteredBizBot = nodeContent => {
	if (!Array.isArray(nodeContent)) return false
	return nodeContent.some(b => ['bot'].includes(b?.tag) && b?.attrs?.biz_bot === '1')
}
const FLOWS_MAP = {
    // Original flow types
    mpm: true,
    // upstream: fix (bug 44): the "catalog" nativeFlow shortcut generates a button
    // named 'catalog_message' (see prepareNativeFlowButtons in messages.js),
    // never 'cta_catalog' — the old key here never matched anything, so
    // catalog_message always fell through to the generic mixed-flow node
    // instead of getting its dedicated native_flow node.
    catalog_message: true,
    send_location: true,
    call_permission_request: true,
    wa_payment_transaction_details: true,
    automated_greeting_message_view_catalog: true,
    // extended button types
    card_message: true,
    order_status: true,
    track_order: true,
    reorder: true,
    cancel_order: true,
    clear_chat: true,
    navigateToScreen: true,
    payment_status: true,
    payment_method: true,
    flow_action: true,
    voice_call: true,
    video_call_button: true,
    otp_button: true,
    authentication_button: true,
    cta_reminder: true,
    cta_cancel_reminder: true,
    // upstream: fix 27-08-26: the real native_flow name for a WhatsApp Flows launch
    // button is 'flow' (matches Button.addFlow()'s button.name after the fix
    // in MessageBuilder.js). 'flow_action' was never a valid native_flow name --
    // it's the name of a *field inside* buttonParamsJson -- so it never actually
    // routed anything real; kept as a harmless alias in case any external caller
    // is still constructing a raw button object with the old (wrong) name.
    flow: true,
    // upstream: fix (bug 68): removed duplicate `flow_action: true` key — already declared
    // above (extended button types block); this was a leftover copy-paste dupe,
    // harmless (same value) but confusing on re-read.
    // upstream: fix (single_select never renders alone) --- single_select must NEVER get
    // its own dedicated native_flow node here. WhatsApp only renders a single_select
    // button through the generic <native_flow v='9' name='mixed'> node — the same one
    // used when it's combined with other buttons. Giving it a dedicated
    // <native_flow v='2' name='single_select'> node (like the other FLOWS_MAP entries)
    // silently fails to render client-side, whether single_select is alone or is simply
    // the first button in the array. Removed from this map on purpose so it always
    // falls through to the `flowMsg` mixed-flow branch below.
};
const DECISION_SOURCE_CONTENT = [
    {
        tag: 'decision_source',
        attrs: { value: 'df' }
    }
];
const LIST_TYPE_CONTENT = {
    tag: 'list',
    attrs: { v: '2', type: 'product_list' }
};
const NATIVE_FLOW_ATTRIBUTE = { type: 'native_flow', v: '1' };
const MIXED_NATIVE_FLOW = {
    tag: 'interactive',
    attrs: NATIVE_FLOW_ATTRIBUTE,
    content: [
        {
            tag: 'native_flow',
            attrs: { v: '9', name: 'mixed' }
        }
    ]
};
export const getBizBinaryNode = (message) => {
    const flowMsg = message.interactiveMessage?.nativeFlowMessage;
    const firstButtonName = flowMsg?.buttons?.[0]?.name;
    const qualityContent = {
        tag: 'quality_control',
        attrs: {
            decision_id: randomBytes(20).toString('hex'),
            source_type: 'third_party'
        },
        content: DECISION_SOURCE_CONTENT
    };
    const bizAttributes = {
        actual_actors: '2',
        host_storage: '2',
        privacy_mode_ts: `${Date.now() / 1_000 | 0}`
    };
    const ORDER_RESPONSE_ALIAS = {
        review_and_pay: 'order_details',
        review_order: 'order_status',
        payment_info: 'payment_info',
        payment_status: 'payment_status',
        payment_method: 'payment_method',
        order_details: 'order_details',
        order_status: 'order_status',
        track_order: 'track_order',
        reorder: 'reorder',
        cancel_order: 'cancel_order',
    };
    if (firstButtonName && ORDER_RESPONSE_ALIAS[firstButtonName]) {
        bizAttributes.native_flow_name = ORDER_RESPONSE_ALIAS[firstButtonName];
        return {
            tag: 'biz',
            attrs: bizAttributes,
            content: [qualityContent]
        };
    }
    if (firstButtonName && FLOWS_MAP[firstButtonName]) {
        return {
            tag: 'biz',
            attrs: bizAttributes,
            content: [
                {
                    tag: 'interactive',
                    attrs: NATIVE_FLOW_ATTRIBUTE,
                    content: [
                        {
                            tag: 'native_flow',
                            attrs: { v: '2', name: firstButtonName }
                        }
                    ]
                },
                qualityContent
            ]
        };
    }
    if (flowMsg || message.buttonsMessage || message.templateMessage) {
        return {
            tag: 'biz',
            attrs: bizAttributes,
            content: [
                MIXED_NATIVE_FLOW,
                qualityContent
            ]
        };
    }
    if (message.listMessage) {
        return {
            tag: 'biz',
            attrs: bizAttributes,
            content: [
                LIST_TYPE_CONTENT,
                qualityContent
            ]
        };
    }
    return {
        tag: 'biz',
        attrs: bizAttributes,
        content: [qualityContent]
    };
};
//# sourceMappingURL=generic-utils.js.map