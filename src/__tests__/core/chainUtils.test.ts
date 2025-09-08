import axios from 'axios';
import { makeRequest, loadChainInfo, getAvailableChains, validateChainEndpoints } from '../../core/chainUtils.js';
import { promises as fs } from 'fs';

jest.mock('axios');
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    readdir: jest.fn()
  }
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedFs = fs as jest.Mocked<typeof fs>;

describe('ChainUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('makeRequest', () => {
    it('should successfully make a request to the first endpoint', async () => {
      const mockResponse = {
        data: { result: { test: 'data' } },
        status: 200
      };
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const result = await makeRequest(['http://endpoint1.com'], '/test');
      
      expect(result).toEqual({ test: 'data' });
      expect(mockedAxios).toHaveBeenCalledWith({
        method: 'get',
        url: 'http://endpoint1.com/test',
        data: null,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ibc-escrow-audit/1.0.0'
        }
      });
    });

    it('should return raw data for Sei chains', async () => {
      const mockResponse = {
        data: { test: 'data' },
        status: 200
      };
      mockedAxios.mockResolvedValueOnce(mockResponse);

      const result = await makeRequest(['http://sei-endpoint.com'], '/test');
      
      expect(result).toEqual({ test: 'data' });
    });

    it('should retry on network errors', async () => {
      mockedAxios
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          data: { result: { success: true } },
          status: 200
        });

      const result = await makeRequest(['http://endpoint1.com'], '/test');
      
      expect(result).toEqual({ success: true });
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 4xx client errors except 429', async () => {
      const error = {
        response: { status: 400, data: { message: 'Bad Request' } },
        message: 'Request failed'
      };
      mockedAxios.mockRejectedValueOnce(error);

      await expect(makeRequest(['http://endpoint1.com'], '/test'))
        .rejects.toThrow('Client error 400: Bad Request');
      
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('should fail after all retries exhausted', async () => {
      mockedAxios.mockRejectedValue(new Error('Network error'));

      await expect(makeRequest(['http://endpoint1.com'], '/test'))
        .rejects.toThrow('All requests failed after 3 attempts for path: /test');
    });
  });

  describe('loadChainInfo', () => {
    it('should successfully load chain info', async () => {
      const mockChainData = {
        chain_name: 'testchain',
        chain_id: 'testchain-1',
        bech32_prefix: 'test',
        apis: {
          rest: [{ address: 'http://rest.test.com' }],
          rpc: [{ address: 'http://rpc.test.com' }]
        },
        staking: {
          staking_tokens: [{ denom: 'utest' }]
        }
      };
      
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(mockChainData));

      const result = await loadChainInfo('testchain');
      
      expect(result).toEqual(mockChainData);
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        expect.stringContaining('testchain.json'),
        'utf8'
      );
    });

    it('should throw error for invalid chain data structure', async () => {
      const invalidChainData = {
        chain_name: 'testchain'
        // Missing apis
      };
      
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(invalidChainData));

      await expect(loadChainInfo('testchain'))
        .rejects.toThrow('Invalid chain info structure for testchain');
    });

    it('should throw error for chains without API endpoints', async () => {
      const chainDataWithoutEndpoints = {
        chain_name: 'testchain',
        apis: {
          rest: [],
          grpc: []
        }
      };
      
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(chainDataWithoutEndpoints));

      await expect(loadChainInfo('testchain'))
        .rejects.toThrow('No REST or gRPC endpoints found for testchain');
    });

    it('should handle file read errors', async () => {
      mockedFs.readFile.mockRejectedValueOnce(new Error('File not found'));

      await expect(loadChainInfo('nonexistent'))
        .rejects.toThrow('Chain info not found for nonexistent: Error: File not found');
    });
  });

  describe('getAvailableChains', () => {
    it('should return list of chain names', async () => {
      mockedFs.readdir.mockResolvedValueOnce([
        'osmosis.json',
        'juno.json',
        'chain.schema.json', // Should be filtered out
        'cosmos.json'
      ] as any);

      const result = await getAvailableChains();
      
      expect(result).toEqual(['cosmos', 'juno', 'osmosis']);
    });

    it('should handle directory read errors', async () => {
      mockedFs.readdir.mockRejectedValueOnce(new Error('Directory not found'));

      await expect(getAvailableChains())
        .rejects.toThrow('Failed to read chain directory: Error: Directory not found');
    });
  });

  describe('validateChainEndpoints', () => {
    it('should validate healthy REST and RPC endpoints', async () => {
      const chainInfo = {
        chain_name: 'testchain',
        apis: {
          rest: [
            { address: 'http://rest1.test.com' },
            { address: 'http://rest2.test.com' }
          ],
          rpc: [
            { address: 'http://rpc1.test.com' },
            { address: 'http://rpc2.test.com' }
          ],
          grpc: [
            { address: 'grpc.test.com:9090' }
          ]
        }
      } as any;

      // Mock successful REST endpoint validation
      mockedAxios.mockResolvedValueOnce({ data: { result: {} }, status: 200 });
      mockedAxios.mockRejectedValueOnce(new Error('Network error'));
      
      // Mock successful RPC endpoint validation
      mockedAxios.get = jest.fn()
        .mockResolvedValueOnce({ status: 200 })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await validateChainEndpoints(chainInfo);
      
      expect(result.restEndpoints).toHaveLength(2);
      expect(result.rpcEndpoints).toHaveLength(2);
      expect(result.grpcEndpoints).toHaveLength(1);
      expect(result.healthyEndpoints.rest).toHaveLength(1);
      expect(result.healthyEndpoints.rpc).toHaveLength(1);
      expect(result.healthyEndpoints.grpc).toHaveLength(1); // Assumed healthy
    });
  });
});