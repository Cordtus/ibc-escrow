# IBC Escrow Audit Tool

TypeScript CLI tool for auditing IBC token escrow accounts between Cosmos chains. Verifies token balances and performs recursive IBC denomination tracing to origin chains.

## Requirements

- Node.js >=14.0.0
- Yarn 1.22+

## Installation

```bash
git clone https://github.com/cordtus/ibc-escrow-audit.git
cd ibc-escrow-audit
yarn install
```

## Configuration

### Environment Variables
```bash
# Optional: GitHub PAT for higher API rate limits
GITHUB_PAT=your_github_token
```

### Config File
Edit `config.json`:

```json
{
  "audit": {
    "useGrpc": true,
    "defaultType": "quick"
  },
  "logging": {
    "level": "info"
  }
}
```

## Usage

### Interactive CLI
```bash
yarn start
```

### Direct Commands
```bash
yarn quick              # Native token audit only
yarn comprehensive     # Full recursive IBC audit
yarn update-chains     # Sync chain registry data
```

### Command-Line Arguments
```bash
node dist/audit.js quick            # Quick audit
node dist/audit.js comprehensive    # Comprehensive audit
node dist/updateChains.js -f        # Force chain data update
```

## Audit Types

**Quick Audit**
- Audits native/staking tokens only
- Compares escrow balances with counterparty supplies
- Executes bidirectional verification

**Comprehensive Audit**
- Processes all tokens in escrow accounts
- Performs recursive IBC denomination unwrapping
- Traces multi-hop token paths to origin chains
- Validates complete supply chain integrity

**Manual Channel**
- Specify custom channel IDs for targeted audits

## Architecture

### Protocol Support
- **Primary**: gRPC (Cosmos SDK gRPC endpoints)
- **Fallback**: REST (Cosmos LCD API)
- **Selection**: Interactive prompt or config-based

### Dependencies
| Component | Protocol | Purpose |
|-----------|----------|---------|
| Balance queries | gRPC/REST | Token balance retrieval |
| Supply queries | gRPC/REST | Total supply validation |
| IBC tracing | gRPC/REST | Multi-hop denomination resolution |
| Chain registry | GitHub REST | Chain configuration sync |
| Version monitoring | RPC | Cache invalidation triggers |

### Data Sources
- **Cosmos Chain Registry**: Chain configurations, IBC channel data
- **Chain APIs**: Real-time balance and supply data
- **Local Cache**: gRPC descriptors, chain metadata

## Development

### Build Commands
```bash
yarn build              # Compile TypeScript
yarn dev                # Watch mode compilation
yarn clean              # Remove build artifacts
```

### Testing
```bash
yarn test               # Full test suite
yarn test:watch         # Watch mode
yarn test:coverage      # Coverage report
yarn test src/__tests__/core/ibcUtils.test.ts  # Single file
```

### Code Quality
```bash
yarn lint               # ESLint
yarn lint:fix           # Auto-fix issues
yarn format             # Prettier formatting
```

## Output Structure

### Audit Results
```typescript
interface AuditResult {
  chainName: string;
  channelId: string;
  escrowAddress: string;
  escrowBalance: string;
  counterpartySupply: string;
  isBalanced: boolean;
  discrepancy?: string;
}
```

### IBC Token Tracing
```typescript
interface TokenTraceResult {
  baseDenom: string;
  originChain: string;
  path: IBCTransferPath[];
  isComplete: boolean;
}
```

## Performance

### gRPC Optimization
- Connection pooling across queries
- Descriptor caching with version-aware invalidation
- Exponential backoff retry logic

### Caching Strategy
- **Memory**: LRU cache for recent queries
- **Disk**: Persistent gRPC descriptors and chain data
- **Invalidation**: Chain version monitoring via `/abci_info`

## Logging

Logs written to console and files in `logs/`:
- `combined.log`: All messages
- `error.log`: Error-level only

Performance metrics logged for:
- API request timing
- gRPC query duration
- Audit completion time
- Cache hit/miss rates

## Error Handling

### Common Issues
- **Rate Limits**: Increase `delay` in config or use GitHub PAT
- **Chain Unavailable**: Tool automatically tries alternate endpoints
- **gRPC Failures**: Falls back to REST endpoints
- **Cache Corruption**: Clear `data/grpc-cache/` directory

### Debug Mode
```json
{
  "logging": {
    "level": "debug"
  }
}
```

## License

MIT