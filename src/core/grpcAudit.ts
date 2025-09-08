import logger from './logger.js';
import { 
  fetchBalanceGrpc, 
  fetchSupplyGrpc, 
  fetchDenomTraceGrpc,
  recursiveUnwrapTokenGrpc,
  closeAllGrpcClients
} from './grpcChainUtils.js';
import { loadChainInfo } from './chainUtils.js';
import { hashIBCDenom } from './ibcUtils.js';
import type { ChainInfo, AuditResult } from '../types/common.js';

export interface GrpcComprehensiveAuditResult extends AuditResult {
  tokens: Array<{
    denom: string;
    amount: string;
    isNative: boolean;
    originChain?: string;
    originalDenom?: string;
    escrowBalance?: string;
    originBalance?: string;
    discrepancy?: string;
    traceComplete: boolean;
    hops?: Array<{
      fromChain: string;
      toChain: string;
      channelId: string;
      portId: string;
    }>;
  }>;
  totalTokensAudited: number;
  nativeTokens: number;
  ibcTokens: number;
  successfulTraces: number;
  failedTraces: number;
  grpcPerformance: {
    totalQueries: number;
    averageLatency: number;
    cacheHits: number;
  };
}

export async function performGrpcQuickAudit(
  primaryChain: string,
  secondaryChain: string,
  channelId: string,
  reverse: boolean = false
): Promise<AuditResult[]> {
  logger.info(`Starting gRPC quick audit: ${primaryChain} <-> ${secondaryChain}`);
  const startTime = Date.now();

  try {
    const results: AuditResult[] = [];
    
    // Load chain information
    const [primaryChainInfo, secondaryChainInfo] = await Promise.all([
      loadChainInfo(primaryChain),
      loadChainInfo(secondaryChain)
    ]);

    if (!primaryChainInfo || !secondaryChainInfo) {
      throw new Error(`Failed to load chain information for ${primaryChain} or ${secondaryChain}`);
    }

    // Perform primary audit using gRPC
    const primaryResult = await performSingleChainGrpcAudit(
      primaryChainInfo,
      secondaryChainInfo,
      channelId,
      'primary'
    );
    results.push(primaryResult);

    // Perform reverse audit if requested
    if (reverse) {
      // For simplicity, use the same channel ID (in practice, find counterparty)
      const reverseResult = await performSingleChainGrpcAudit(
        secondaryChainInfo,
        primaryChainInfo,
        channelId,
        'reverse'
      );
      results.push(reverseResult);
    }

    const duration = Date.now() - startTime;
    logger.performance('grpc_quick_audit', duration, {
      primaryChain,
      secondaryChain,
      reverse,
      resultsCount: results.length
    });

    return results;

  } catch (error) {
    logger.error(`gRPC quick audit failed: ${error}`);
    throw error;
  }
}

async function performSingleChainGrpcAudit(
  chainInfo: ChainInfo,
  counterpartyChainInfo: ChainInfo,
  channelId: string,
  direction: 'primary' | 'reverse'
): Promise<AuditResult> {
  const chainName = chainInfo.chain_name;
  logger.info(`Performing ${direction} gRPC audit on ${chainName} (channel: ${channelId})`);

  try {
    // Get native token info
    const nativeToken = chainInfo.staking?.staking_tokens?.[0]?.denom || '';
    if (!nativeToken) {
      throw new Error(`No native staking token found for ${chainName}`);
    }

    // Calculate escrow address (simplified - should use proper IBC escrow derivation)
    const escrowAddress = `${chainInfo.bech32_prefix}1${generateEscrowSuffix(channelId)}`;
    logger.info(`Using escrow address: ${escrowAddress}`);

    // Get escrow balance using gRPC
    const escrowBalances = await fetchBalanceGrpc(chainName, escrowAddress, nativeToken);
    const escrowBalance = escrowBalances.find(b => b.denom === nativeToken)?.amount || '0';

    // Calculate what the IBC denom would be on the counterparty chain
    const ibcDenom = hashIBCDenom('transfer', channelId, nativeToken);
    
    // Get total supply of the IBC token on counterparty chain using gRPC
    let expectedBalance = '0';
    try {
      const counterpartySupply = await fetchSupplyGrpc(counterpartyChainInfo.chain_name, ibcDenom);
      expectedBalance = counterpartySupply.amount;
    } catch (error) {
      logger.warn(`Could not fetch counterparty supply via gRPC for ${ibcDenom}: ${error}`);
    }

    // Calculate discrepancy
    const escrowBig = BigInt(escrowBalance);
    const expectedBig = BigInt(expectedBalance);
    const discrepancy = (escrowBig - expectedBig).toString();

    logger.info(`gRPC audit complete - Escrow: ${escrowBalance}, Expected: ${expectedBalance}, Discrepancy: ${discrepancy}`);

    return {
      chainName,
      escrowAddress,
      nativeToken,
      escrowBalance,
      expectedBalance,
      discrepancy,
      timestamp: Date.now()
    };

  } catch (error) {
    logger.error(`Single chain gRPC audit failed for ${chainName}: ${error}`);
    throw error;
  }
}

export async function performGrpcComprehensiveAudit(
  primaryChain: string,
  secondaryChain: string,
  channelId?: string
): Promise<GrpcComprehensiveAuditResult> {
  logger.info(`Starting comprehensive gRPC audit: ${primaryChain} <-> ${secondaryChain}`);
  const startTime = Date.now();
  let queryCount = 0;
  let totalLatency = 0;
  let cacheHits = 0;

  try {
    // Load chain information
    const primaryChainInfo = await loadChainInfo(primaryChain);
    
    if (!primaryChainInfo) {
      throw new Error(`Failed to load chain information for ${primaryChain}`);
    }

    // Get the escrow address (simplified - in practice this would be calculated properly)
    const escrowAddress = getEscrowAddress(primaryChainInfo, channelId || 'channel-0');
    
    // Get all tokens in escrow using gRPC
    const escrowTokens = await getAllEscrowTokensGrpc(primaryChainInfo.chain_name, escrowAddress);
    logger.info(`Found ${escrowTokens.length} tokens in escrow address ${escrowAddress}`);

    const auditResults = [];
    let nativeCount = 0;
    let ibcCount = 0;
    let successfulTraces = 0;
    let failedTraces = 0;

    // Audit each token
    for (const token of escrowTokens) {
      logger.info(`Auditing token via gRPC: ${token.denom} (${token.amount})`);
      
      if (token.isNative) {
        nativeCount++;
        const nativeAudit = await auditNativeTokenGrpc(
          primaryChain,
          secondaryChain,
          token,
          channelId
        );
        auditResults.push(nativeAudit);
      } else {
        ibcCount++;
        const ibcAudit = await auditIbcTokenGrpc(
          primaryChain,
          token
        );
        auditResults.push(ibcAudit);
        
        if (ibcAudit.traceComplete) {
          successfulTraces++;
        } else {
          failedTraces++;
        }
      }
      queryCount++;
    }

    const duration = Date.now() - startTime;
    const averageLatency = queryCount > 0 ? totalLatency / queryCount : 0;
    
    logger.performance('grpc_comprehensive_audit', duration, {
      primaryChain,
      secondaryChain,
      tokensAudited: escrowTokens.length,
      nativeTokens: nativeCount,
      ibcTokens: ibcCount,
      queryCount
    });

    return {
      chainName: primaryChain,
      escrowAddress,
      nativeToken: primaryChainInfo.staking?.staking_tokens?.[0]?.denom || '',
      escrowBalance: escrowTokens.find(t => t.isNative)?.amount || '0',
      timestamp: Date.now(),
      tokens: auditResults,
      totalTokensAudited: escrowTokens.length,
      nativeTokens: nativeCount,
      ibcTokens: ibcCount,
      successfulTraces,
      failedTraces,
      grpcPerformance: {
        totalQueries: queryCount,
        averageLatency,
        cacheHits
      }
    };

  } catch (error) {
    logger.error(`Comprehensive gRPC audit failed: ${error}`);
    throw error;
  } finally {
    // Clean up gRPC connections
    await closeAllGrpcClients();
  }
}

async function getAllEscrowTokensGrpc(
  chainName: string,
  escrowAddress: string
): Promise<Array<{
  denom: string;
  amount: string;
  isNative: boolean;
}>> {
  try {
    const balances = await fetchBalanceGrpc(chainName, escrowAddress);
    
    const tokens = balances.map(balance => ({
      denom: balance.denom,
      amount: balance.amount,
      isNative: !balance.denom.startsWith('ibc/')
    }));
    
    logger.info(`Found ${tokens.length} tokens in escrow address ${escrowAddress}`);
    return tokens;
    
  } catch (error) {
    logger.error(`Failed to get escrow tokens via gRPC: ${error}`);
    throw error;
  }
}

async function auditNativeTokenGrpc(
  primaryChain: string,
  secondaryChain: string,
  token: { denom: string; amount: string; isNative: boolean },
  channelId?: string
): Promise<GrpcComprehensiveAuditResult['tokens'][0]> {
  try {
    // Calculate what the IBC denom would be on the secondary chain
    const portId = 'transfer';
    const ibcDenom = hashIBCDenom(portId, channelId || 'channel-0', token.denom);
    
    // Fetch supply on secondary chain using gRPC
    let secondaryBalance: string | undefined;
    try {
      const supply = await fetchSupplyGrpc(secondaryChain, ibcDenom);
      secondaryBalance = supply.amount;
    } catch (error) {
      logger.warn(`Could not fetch counterparty supply via gRPC for ${ibcDenom}: ${error}`);
    }
    
    // Calculate discrepancy
    const escrowAmount = BigInt(token.amount);
    const secondaryAmount = BigInt(secondaryBalance || '0');
    const discrepancy = escrowAmount - secondaryAmount;
    
    logger.debug(`Native token gRPC audit - Escrow: ${token.amount}, Secondary: ${secondaryBalance}, Discrepancy: ${discrepancy}`);
    
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: true,
      escrowBalance: token.amount,
      originBalance: secondaryBalance,
      discrepancy: discrepancy.toString(),
      traceComplete: true
    };
    
  } catch (error) {
    logger.error(`Failed to audit native token via gRPC ${token.denom}: ${error}`);
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: true,
      traceComplete: false
    };
  }
}

async function auditIbcTokenGrpc(
  primaryChain: string,
  token: { denom: string; amount: string; isNative: boolean }
): Promise<GrpcComprehensiveAuditResult['tokens'][0]> {
  try {
    // Use the enhanced recursive unwrapping with gRPC
    const traceResult = await recursiveUnwrapTokenGrpc(primaryChain, token.denom);
    
    if (!traceResult.isComplete) {
      logger.warn(`Incomplete gRPC trace for IBC token ${token.denom}`);
      return {
        denom: token.denom,
        amount: token.amount,
        isNative: false,
        traceComplete: false
      };
    }
    
    // Get total supply of the origin token using gRPC
    let originSupply: string;
    try {
      const supply = await fetchSupplyGrpc(traceResult.originChain, traceResult.baseDenom);
      originSupply = supply.amount;
    } catch (error) {
      logger.warn(`Could not fetch origin supply via gRPC for ${traceResult.baseDenom}: ${error}`);
      originSupply = '0';
    }
    
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: false,
      originChain: traceResult.originChain,
      originalDenom: traceResult.baseDenom,
      escrowBalance: token.amount,
      originBalance: originSupply,
      hops: traceResult.path.map(hop => ({
        fromChain: hop.chain,
        toChain: 'next-chain', // Would need to be calculated
        channelId: hop.channelId,
        portId: hop.portId
      })),
      traceComplete: true
    };
    
  } catch (error) {
    logger.error(`Failed to audit IBC token via gRPC ${token.denom}: ${error}`);
    return {
      denom: token.denom,
      amount: token.amount,
      isNative: false,
      traceComplete: false
    };
  }
}

function generateEscrowSuffix(channelId: string): string {
  // Simplified escrow address generation
  // In practice, this would use the proper IBC module address derivation
  const channelNumber = channelId.replace('channel-', '');
  return `escrow${channelNumber}`;
}

function getEscrowAddress(chainInfo: ChainInfo, channelId: string): string {
  // Simplified escrow address generation - in practice this would use the actual IBC module logic
  const portId = 'transfer';
  return `${chainInfo.bech32_prefix}1escrow${channelId.replace('channel-', '')}`;
}