# IBC Escrow Audit Tool

This tool performs an IBC escrow audit between two Cosmos chains, verifying the balances of IBC tokens in escrow accounts.

## Features

- Automatic fetching and caching of chain data from the Cosmos Chain Registry
- IBC data validation against live chain data
- Escrow balance auditing for IBC tokens
- Detailed logging for easy troubleshooting and monitoring
- Support for interactive and command-line modes

## Prerequisites

- Node.js (v14 or later)
- Yarn (v1.22 or later)
- GitHub Personal Access Token (optional, but recommended)

> Using a GitHub PAT increases the API rate limit from 60 to 5,000 requests per hour. While not required, it significantly reduces the likelihood of encountering rate limit errors during chain data updates and normal usage.

## Setup

1. Clone this repository:
   ```
   git clone https://github.com/your-username/ibc-escrow-audit.git
   cd ibc-escrow-audit
   ```

2. Install dependencies:
   ```
   yarn install
   ```

3. Create a `.env` file in the root directory and add your GitHub PAT:
   ```
   GITHUB_PAT=your_github_personal_access_token_here
   ```

## Usage

Run the script with one of the following commands:

1. Interactive mode (recommended for first-time users):
   ```
   yarn start
   ```
   This will prompt you for the necessary inputs.

2. Command-line mode:
   ```
   yarn start <primaryChainName> <secondaryChainName>
   ```
   - `<primaryChainName>`: The name of the primary chain
   - `<secondaryChainName>`: The name of the secondary chain

   Example:
   ```
   yarn start osmosis cosmos
   ```

The tool will automatically fetch the necessary IBC data and perform the audit.

## First Run

On the first run, the script will cache chain data and IBC data from the Cosmos Chain Registry. This process may take a few minutes. The data will be stored in a `data` directory for future use.

## Updating Chain Data

The tool caches chain and IBC data locally to improve performance and reduce API calls. There are several ways to update this data:

1. Automatic update when data is missing:
   If you try to audit chains that don't have local data, you'll be prompted to update the data.

2. Manual update:
   You can manually update the chain and IBC data by running:
   ```
   yarn update-chains
   ```
   This will check for updates to all chains and IBC data, and only download data that has been updated since your last download.

3. Forced update:
   To force an update of all chain and IBC data regardless of their last update time, run:
   ```
   yarn update-chains-force
   ```

## Logging

The tool uses Winston for logging. Logs are written to the console and to log files in the `logs` directory:
- `error.log`: Contains only error messages
- `combined.log`: Contains all log messages (info, warn, error)

## Troubleshooting

- If you encounter rate limiting issues, check the `delay` value in `config.json`.
- Make sure your GitHub PAT has the necessary permissions to access public repositories.
- If a chain's data fails to load, ensure it exists in the Cosmos Chain Registry and has a valid `chain.json` file.
- If you're having issues with a specific chain, try running a forced update using `yarn update-chains-force`.
- Check the log files in the `logs` directory for detailed information about any errors or issues.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.