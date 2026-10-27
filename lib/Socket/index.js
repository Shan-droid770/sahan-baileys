import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
import { makeBanCheckerSocket } from './ban-checker.js';
import { AIRich } from '../Builders/AIRich.js';
// export the last socket layer
const makeWASocket = (config) => {
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config
    };
    const sock = makeBanCheckerSocket(makeCommunitiesSocket(newConfig));
    sock.createAIRich = (options = {}) => new AIRich(sock, options);
    return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map
