import { ChainDataUpdater } from '../../utils/updateChains.js';
import { performGrpcQuickAudit, performGrpcComprehensiveAudit } from '../../core/grpcAudit.js';
import { performQuickAudit } from '../../audit.js';
import { loadChainInfo, getAvailableChains } from '../../core/chainUtils.js';
import { validateGrpcEndpoints } from '../../core/grpcChainUtils.js';
import logger from '../../core/logger.js';
import { promises as fs } from 'fs';
import path from 'path';

// Mock external dependencies for e2e tests
jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn()
  }
}));

jest.mock('axios');
global.fetch = jest.fn();

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('End-to-End Audit Workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock basic file system operations
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.readdir.mockResolvedValue([]);
    mockedFs.writeFile.mockResolvedValue(undefined);
  });

  describe('Chain Data Management', () => {
    it('should update chain registry data', async () => {
      const updater = new ChainDataUpdater();
      
      // Mock successful update
      mockedFs.readdir.mockResolvedValueOnce(['osmosis.json', 'cosmos.json'] as any);
      
      await expect(updater.updateChains(true)).resolves.not.toThrow();
    });

    it('should load available chains', async () => {
      mockedFs.readdir.mockResolvedValueOnce([
        'osmosis.json',
        'cosmos.json', 
        'juno.json',
        'chain.schema.json'
      ] as any);

      const chains = await getAvailableChains();
      
      expect(chains).toEqual(['cosmos', 'juno', 'osmosis']);
    });

    it('should load chain configuration', async () => {
      const mockChainData = {
        chain_name: 'osmosis',
        chain_id: 'osmosis-1',
        bech32_prefix: 'osmo',
        apis: {
          rest: [{ address: 'https://rest.osmosis.zone' }],
          grpc: [{ address: 'grpc.osmosis.zone:9090' }],
          rpc: [{ address: 'https://rpc.osmosis.zone' }]
        },
        staking: {
          staking_tokens: [{ denom: 'uosmo' }]
        }
      };
      
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(mockChainData));

      const chainInfo = await loadChainInfo('osmosis');
      
      expect(chainInfo.chain_name).toBe('osmosis');
      expect(chainInfo.apis.grpc).toHaveLength(1);
    });
  });

  describe('gRPC Integration', () => {
    it('should validate gRPC endpoints', async () => {
      const mockChainData = {
        chain_name: 'osmosis',
        apis: {
          grpc: [
            { address: 'grpc.osmosis.zone:9090' },
            { address: 'grpc2.osmosis.zone:9090' }
          ]
        }
      };
      
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(mockChainData));

      // Test would check actual gRPC connectivity in real implementation
      const result = await validateGrpcEndpoints('osmosis');
      
      expect(result).toHaveProperty('healthyEndpoints');
      expect(result).toHaveProperty('unhealthyEndpoints');
    });
  });

  describe('Full Audit Workflows', () => {
    const mockOsmosisChain = {
      chain_name: 'osmosis',
      chain_id: 'osmosis-1',
      bech32_prefix: 'osmo',
      apis: {
        rest: [{ address: 'https://rest.osmosis.zone' }],
        grpc: [{ address: 'grpc.osmosis.zone:9090' }],
        rpc: [{ address: 'https://rpc.osmosis.zone' }]
      },
      staking: {
        staking_tokens: [{ denom: 'uosmo' }]
      }
    };

    const mockCosmosChain = {
      chain_name: 'cosmoshub',
      chain_id: 'cosmoshub-4',
      bech32_prefix: 'cosmos',
      apis: {
        rest: [{ address: 'https://rest.cosmos.network' }],
        grpc: [{ address: 'grpc.cosmos.network:9090' }],
        rpc: [{ address: 'https://rpc.cosmos.network' }]
      },
      staking: {
        staking_tokens: [{ denom: 'uatom' }]
      }
    };

    beforeEach(() => {
      // Mock chain loading
      mockedFs.readFile
        .mockImplementation((filePath: any) => {
          const filename = path.basename(filePath);
          if (filename === 'osmosis.json') {
            return Promise.resolve(JSON.stringify(mockOsmosisChain));
          }
          if (filename === 'cosmoshub.json') {
            return Promise.resolve(JSON.stringify(mockCosmosChain));
          }
          return Promise.reject(new Error('File not found'));
        });
    });

    it('should perform complete REST audit workflow', async () => {
      // Mock successful REST audit
      const results = await performQuickAudit('osmosis', 'cosmoshub', 'channel-0', false);
      
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('chainName');
      expect(results[0]).toHaveProperty('escrowBalance');
      expect(results[0]).toHaveProperty('timestamp');
    }, 30000);

    it('should perform complete gRPC audit workflow', async () => {
      // This would test the full gRPC audit in a real environment
      // For now, we test the interface
      
      const results = await performGrpcQuickAudit('osmosis', 'cosmoshub', 'channel-0', false);
      
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('chainName');
      expect(results[0]).toHaveProperty('escrowBalance');
      expect(results[0]).toHaveProperty('timestamp');
    }, 30000);

    it('should perform comprehensive audit with token tracing', async () => {
      // Mock comprehensive audit with multiple tokens
      const result = await performGrpcComprehensiveAudit('osmosis', 'cosmoshub', 'channel-0');
      
      expect(result).toHaveProperty('totalTokensAudited');
      expect(result).toHaveProperty('nativeTokens');
      expect(result).toHaveProperty('ibcTokens');
      expect(result).toHaveProperty('grpcPerformance');
      expect(result.tokens).toBeDefined();
    }, 60000);

    it('should handle audit errors gracefully', async () => {
      // Test error handling
      await expect(performGrpcQuickAudit('nonexistent', 'cosmoshub', 'channel-0', false))
        .rejects.toThrow();
    });

    it('should handle missing chain data gracefully', async () => {
      mockedFs.readFile.mockRejectedValue(new Error('Chain not found'));
      
      await expect(loadChainInfo('nonexistent'))
        .rejects.toThrow('Chain info not found for nonexistent');
    });
  });

  describe('Performance and Monitoring', () => {
    it('should log performance metrics during audit', async () => {
      const logSpy = jest.spyOn(logger, 'performance');
      
      try {
        await performGrpcQuickAudit('osmosis', 'cosmoshub', 'channel-0', false);
      } catch {
        // Expected to fail in test environment
      }
      
      // Should have attempted to log performance
      expect(logSpy).toHaveBeenCalled();
    });

    it('should log audit completion events', async () => {
      const auditSpy = jest.spyOn(logger, 'audit');
      
      try {
        await performGrpcQuickAudit('osmosis', 'cosmoshub', 'channel-0', false);
      } catch {
        // Expected to fail in test environment  
      }
      
      // Should have attempted to log audit events
      expect(auditSpy).toHaveBeenCalled();
    });
  });
});