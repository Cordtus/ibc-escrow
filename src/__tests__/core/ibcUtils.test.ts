import { promises as fs } from 'fs';
import { loadIBCData, validateIBCData, validateId, hashIBCDenom } from '../../core/ibcUtils.js';

jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    readFile: jest.fn()
  }
}));

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('IBCUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateId', () => {
    it('should validate correct channel ID format', () => {
      expect(() => validateId('channel-0', 'channel')).not.toThrow();
      expect(() => validateId('channel-123', 'channel')).not.toThrow();
    });

    it('should validate correct connection ID format', () => {
      expect(() => validateId('connection-0', 'connection')).not.toThrow();
      expect(() => validateId('connection-456', 'connection')).not.toThrow();
    });

    it('should validate correct client ID format', () => {
      expect(() => validateId('07-tendermint-0', 'client')).not.toThrow();
      expect(() => validateId('07-tendermint-789', 'client')).not.toThrow();
    });

    it('should throw error for invalid channel ID format', () => {
      expect(() => validateId('invalid-channel', 'channel'))
        .toThrow('Invalid channel ID format: invalid-channel');
      expect(() => validateId('channel', 'channel'))
        .toThrow('Invalid channel ID format: channel');
      expect(() => validateId('channel-abc', 'channel'))
        .toThrow('Invalid channel ID format: channel-abc');
    });

    it('should throw error for invalid connection ID format', () => {
      expect(() => validateId('invalid-connection', 'connection'))
        .toThrow('Invalid connection ID format: invalid-connection');
    });

    it('should throw error for invalid client ID format', () => {
      expect(() => validateId('invalid-client', 'client'))
        .toThrow('Invalid client ID format: invalid-client');
    });
  });

  describe('hashIBCDenom', () => {
    it('should generate correct IBC denom hash', () => {
      const result = hashIBCDenom('transfer', 'channel-0', 'uatom');
      
      expect(result).toMatch(/^ibc\/[A-F0-9]{64}$/);
      expect(result.startsWith('ibc/')).toBe(true);
    });

    it('should generate consistent hashes for same input', () => {
      const hash1 = hashIBCDenom('transfer', 'channel-0', 'uatom');
      const hash2 = hashIBCDenom('transfer', 'channel-0', 'uatom');
      
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different inputs', () => {
      const hash1 = hashIBCDenom('transfer', 'channel-0', 'uatom');
      const hash2 = hashIBCDenom('transfer', 'channel-1', 'uatom');
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('validateIBCData', () => {
    const validIBCData = {
      $schema: 'test-schema',
      chain_1: {
        chain_name: 'osmosis',
        client_id: '07-tendermint-0',
        connection_id: 'connection-0'
      },
      chain_2: {
        chain_name: 'cosmos',
        client_id: '07-tendermint-1',
        connection_id: 'connection-1'
      },
      channels: [
        {
          chain_1: {
            channel_id: 'channel-0',
            port_id: 'transfer'
          },
          chain_2: {
            channel_id: 'channel-141',
            port_id: 'transfer'
          },
          ordering: 'unordered',
          version: 'ics20-1'
        }
      ]
    };

    it('should validate correct IBC data structure', () => {
      expect(validateIBCData(validIBCData)).toBe(true);
    });

    it('should reject null or undefined data', () => {
      expect(validateIBCData(null)).toBe(false);
      expect(validateIBCData(undefined)).toBe(false);
    });

    it('should reject non-object data', () => {
      expect(validateIBCData('string')).toBe(false);
      expect(validateIBCData(123)).toBe(false);
      expect(validateIBCData([])).toBe(false);
    });

    it('should reject data missing required fields', () => {
      const invalidData = { ...validIBCData };
      delete invalidData.chain_1;
      
      expect(validateIBCData(invalidData)).toBe(false);
    });

    it('should reject data with empty channels array', () => {
      const invalidData = { ...validIBCData, channels: [] };
      
      expect(validateIBCData(invalidData)).toBe(false);
    });

    it('should reject data with invalid channel structure', () => {
      const invalidData = {
        ...validIBCData,
        channels: [
          {
            chain_1: { channel_id: 'channel-0' }, // Missing port_id
            chain_2: { channel_id: 'channel-141', port_id: 'transfer' },
            ordering: 'unordered',
            version: 'ics20-1'
          }
        ]
      };
      
      expect(validateIBCData(invalidData)).toBe(false);
    });
  });

  describe('loadIBCData', () => {
    const validIBCData = {
      chain_1: { chain_name: 'osmosis' },
      chain_2: { chain_name: 'cosmos' },
      channels: [
        {
          chain_1: { channel_id: 'channel-0', port_id: 'transfer' },
          chain_2: { channel_id: 'channel-141', port_id: 'transfer' },
          ordering: 'unordered',
          version: 'ics20-1'
        }
      ]
    };

    it('should successfully load IBC data for chain pair', async () => {
      mockedFs.readdir.mockResolvedValueOnce(['osmosis--cosmos.json', 'other.json'] as any);
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(validIBCData));

      const result = await loadIBCData('osmosis', 'cosmos');
      
      expect(result).toEqual(validIBCData);
      expect(mockedFs.readdir).toHaveBeenCalled();
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    it('should find IBC file regardless of chain order', async () => {
      mockedFs.readdir.mockResolvedValueOnce(['cosmos--osmosis.json'] as any);
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(validIBCData));

      const result = await loadIBCData('osmosis', 'cosmos');
      
      expect(result).toEqual(validIBCData);
    });

    it('should return null when no matching IBC file found', async () => {
      mockedFs.readdir.mockResolvedValueOnce(['other--chains.json'] as any);

      const result = await loadIBCData('osmosis', 'cosmos');
      
      expect(result).toBeNull();
    });

    it('should throw error for invalid IBC data structure', async () => {
      const invalidData = { invalid: 'data' };
      mockedFs.readdir.mockResolvedValueOnce(['osmosis--cosmos.json'] as any);
      mockedFs.readFile.mockResolvedValueOnce(JSON.stringify(invalidData));

      await expect(loadIBCData('osmosis', 'cosmos'))
        .rejects.toThrow('Invalid IBC data structure');
    });

    it('should handle file system errors', async () => {
      mockedFs.readdir.mockRejectedValueOnce(new Error('Directory not found'));

      await expect(loadIBCData('osmosis', 'cosmos'))
        .rejects.toThrow('Directory not found');
    });
  });
});