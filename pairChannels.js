import { loadIBCData, validateId } from './ibcUtils.js';

async function getChannelPairs(chain1Name, chain2Name) {
  const ibcData = await loadIBCData(chain1Name, chain2Name);

  if (!ibcData) {
    throw new Error(`Unable to load IBC data for ${chain1Name}-${chain2Name}`);
  }

  return ibcData.channels.map((channel) => {
    validateId(channel.chain_1.channel_id, 'channel');
    validateId(channel.chain_2.channel_id, 'channel');
    return {
      [chain1Name]: channel.chain_1.channel_id,
      [chain2Name]: channel.chain_2.channel_id,
      ordering: channel.ordering,
      version: channel.version,
      tags: channel.tags,
    };
  });
}

export default getChannelPairs;
