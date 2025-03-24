// File: recursiveAudit.js

import { makeRequest, loadChainInfo } from './chainUtils.js';
import { fetchIBCData, hashIBCDenom } from './ibcUtils.js';
import logger from './logger.js';
import crypto from 'crypto';

function parseTransferPath(path) {
  const segments = [];
  let remaining = path;

  while (remaining.startsWith('transfer/channel-')) {
    const parts = remaining.split('/', 3);
    if (parts.length < 2) break;

    segments.push({
      port: parts[0],
      channel: parts[1]
    });

    remaining = parts.slice(2).join('/');
  }

  return {
    segments,
    remaining
  };
}

export async function recursiveUnwrap(chainInfo, denom, path = [], fullPath = '') {
  // Base case: If denom is not IBC-prefixed, return the denom and path
  if (!denom.startsWith('ibc/')) {
    logger.info(`Resolved base denom: ${denom} on chain: ${chainInfo.chain_name}`);
    return {
      baseDenom: denom,
      path,
      fullPath: fullPath || denom
    };
  }

  const hash = denom.split('/')[1];
  const tracePath = `/ibc/apps/transfer/v1/denom_traces/${hash}`;

  let traceData;
  try {
    traceData = await makeRequest(chainInfo.apis.rest.map(api => api.address), tracePath);
  } catch (error) {
    logger.error(`Error fetching denom trace for ${denom} on ${chainInfo.chain_name}:`, error.message);
    return { baseDenom: denom, path, fullPath };
  }

  if (!traceData || !traceData.denom_trace) {
    logger.warn(`No denom trace found for ${denom} on ${chainInfo.chain_name}`);
    return { baseDenom: denom, path, fullPath };
  }

  const trace = traceData.denom_trace;
  logger.info(`Found denom trace for ${denom}: ${JSON.stringify(trace)}`);

  // Parse all transfer/channel segments in the path
  const { segments, remaining } = parseTransferPath(trace.path);
  if (segments.length === 0) {
    logger.error(`Invalid denom trace path structure: ${trace.path}`);
    return { baseDenom: denom, path, fullPath };
  }

  // Process each hop in the path
  for (const segment of segments) {
    path.push({
      chain: chainInfo.chain_name,
      port: segment.port,
      channel: segment.channel,
      counterpartyChannel: null // Will be resolved if needed
    });

    // Update the full path
    const pathSegment = `${segment.port}/${segment.channel}`;
    fullPath = fullPath ? `${pathSegment}/${fullPath}` : pathSegment;
  }

  // If the trace.base_denom is also an IBC denom, continue unwrapping
  if (trace.base_denom.startsWith('ibc/')) {
    return recursiveUnwrap(chainInfo, trace.base_denom, path, fullPath);
  }

  // Add the base denom to the full path
  fullPath = fullPath ? `${fullPath}/${trace.base_denom}` : trace.base_denom;

  return {
    baseDenom: trace.base_denom,
    path,
    fullPath
  };
}

export async function hashDenomTrace(path) {
  logger.info(`Hashing full denom trace path: ${path}`);
  const hash = crypto.createHash('sha256').update(path).digest('hex').toUpperCase();
  return `ibc/${hash}`;
}

export async function fetchTotalSupply(chainInfo, denom) {
  const restEndpoints = chainInfo.apis.rest.map(api => api.address);
  const supplyPath = `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`;

  for (const endpoint of restEndpoints) {
    try {
      logger.info(`Fetching total supply for ${denom} from ${endpoint}`);
      const response = await makeRequest([endpoint], supplyPath);
      return response.amount.amount;
    } catch (error) {
      logger.warn(`Failed to fetch total supply from ${endpoint}: ${error.message}`);
    }
  }

  logger.error(`Unable to fetch total supply for ${denom} after trying all endpoints.`);
  return "unavailable"; // Fallback to avoid blocking execution
}

export async function auditToken(primaryChainInfo, secondaryChainInfo, denom, balance) {
  const unwrapResult = await recursiveUnwrap(primaryChainInfo, denom);
  logger.info(`Unwrap result: ${JSON.stringify(unwrapResult)}`);

  // Hash the complete path for proper IBC denom generation
  const counterpartyIbcDenom = await hashDenomTrace(unwrapResult.fullPath);

  try {
    const totalSupply = await fetchTotalSupply(secondaryChainInfo, counterpartyIbcDenom);

    if (totalSupply === "unavailable") {
      logger.warn(`Total supply unavailable for ${counterpartyIbcDenom}. Skipping token.`);
      return {
        token: unwrapResult.baseDenom,
        error: "Total supply unavailable - chain API issue",
        unwrapPath: unwrapResult.path,
        fullPath: unwrapResult.fullPath
      };
    }

    if (balance !== totalSupply) {
      return {
        token: unwrapResult.baseDenom,
        escrowBalance: balance,
        totalSupply: totalSupply,
        difference: BigInt(balance) - BigInt(totalSupply),
        unwrapPath: unwrapResult.path,
        fullPath: unwrapResult.fullPath
      };
    }
  } catch (error) {
    logger.error(`Error auditing token ${unwrapResult.baseDenom}:`, error.message);
    return {
      token: unwrapResult.baseDenom,
      error: error.message,
      unwrapPath: unwrapResult.path,
      fullPath: unwrapResult.fullPath
    };
  }

  return null;
}
