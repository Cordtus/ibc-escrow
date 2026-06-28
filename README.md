# IBC Escrow Audit Tool

TypeScript CLI and static web app for auditing and looking up IBC token escrow accounts between Cosmos chains. The CLI uses gRPC-first audits with REST fallback; the web app performs live escrow and channel lookups through Lazy-LB-compatible universal REST paths or direct `rest.cosmos.directory` requests.

## Requirements

- Node.js >=18.0.0
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

### Web App
```bash
yarn build:web
```

Open `web/index.html` locally, or use the GitHub Pages deployment from this repository. The web UI supports:
- escrow address lookup by chain, port, and channel
- escrow balance lookup through paginated bank balance requests
- optional channel, connection, and client-state lookup sequence
- registry-backed chain selection populated from the hosted Lazy-LB chain summary API
- hosted Lazy-LB routing through `/lb/{chain}/{rest-path}` with no user-entered service URL
- direct REST fallback through `https://rest.cosmos.directory/{chain}`, or an explicit chain-specific REST endpoint entered in the UI

### Terminal UI
```bash
yarn start
```

The default interface opens a colorized terminal menu for quick audits, comprehensive
audits, escrow address lookup, channel inspection, chain data updates, and local
registry status.

### Direct Commands
```bash
yarn quick              # Native token audit only
yarn comprehensive     # Full recursive IBC audit
yarn lookup             # Look up escrow address by chain/channel
yarn channel-info       # Inspect channel, connection, and client state
yarn update-chains     # Sync chain registry data
```

### Command-Line Arguments
```bash
node dist/audit.js quick             # Quick audit
node dist/audit.js comprehensive     # Comprehensive audit
node dist/audit.js lookup            # Escrow address lookup
node dist/audit.js channel-info      # Channel metadata lookup
node dist/audit.js status            # Local registry status
node dist/updateChains.js -f         # Force chain data update
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

**Escrow Lookup**
- Select any chain and registry channel, or enter `channel-0` style IDs manually
- Queries the Cosmos transfer module escrow address endpoint
- Can also fetch counterparty channel, connection, and client details

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
yarn build              # Compile CLI and web TypeScript
yarn build:cli          # Compile CLI TypeScript
yarn build:web          # Compile web TypeScript into web/assets
yarn dev                # Watch mode compilation
yarn clean              # Remove build artifacts
```

### Testing
```bash
yarn test               # Node test runner via tsx
yarn test:watch         # Watch mode
yarn test:coverage      # Experimental Node coverage report
```

### Code Quality
```bash
yarn lint               # Biome check
yarn lint:fix           # Biome auto-fix
yarn format             # Biome formatting
```

### Deployment
The public web app is served at `https://ibc-escrow.cac-group.io/`. Caddy serves
the static `web/` assets from `/srv/ibc-escrow` and reverse proxies same-origin
`/lb/*` requests to the lazy-lb service in the `ibc-escrow` LXC container on
`10.70.48.173:3000`. It also exposes the read-only `/api/chains-summary`
metadata endpoint for chain selection. Chain registry metadata is used for
discovery and endpoint coverage, while escrow addresses, balances, and channel
details are always fetched from live chain REST responses.

GitHub Pages is deployed by `.github/workflows/pages.yml` on pushes to `main`.
The workflow installs dependencies with Yarn, runs `yarn build:web`, and publishes
the `web/` directory.

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
