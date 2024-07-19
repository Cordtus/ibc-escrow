# IBC Escrow Audit Tool

This tool performs an IBC escrow audit between two Cosmos chains.

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
   yarn start <sourceChainName> <targetChainName> <channelId>
   ```
   - `<sourceChainName>`: The name of the source chain
   - `<targetChainName>`: The name of the target chain
   - `<channelId>`: The IBC channel ID to audit

   Example:
   ```
   yarn start osmosis cosmos channel-0
   ```

## First Run

On the first run, the script will cache chain data from the Cosmos Chain Registry. This process may take a few minutes. The data will be stored in a `data` directory for future use.

## Updating Chain Data

The tool caches chain data locally to improve performance and reduce API calls. There are several ways to update this data:

1. Automatic update when data is missing:
   If you try to audit a chain that doesn't have local data, you'll be prompted to update the chain data.

2. Manual update:
   You can manually update the chain data by running:
   ```
   yarn update-chains
   ```
   This will check for updates to all chains and only download data for chains that have been updated since your last download.

3. Forced update:
   To force an update of all chains regardless of their last update time, run:
   ```
   yarn update-chains-force
   ```

### Understanding Update Messages

- "X is up to date.": The local data for chain X is already the latest version.
- "Updating X...": The script is downloading new data for chain X.
- "X updated successfully.": New data for chain X has been downloaded and saved.
- "Warning: X/chain.json not found. Skipping this chain.": The chain.json file for X doesn't exist in the repository. This chain will be skipped.
- "Error updating X: [error message]": An error occurred while trying to update chain X. The error message will provide more details.

## Troubleshooting

- If you encounter rate limiting issues, check the `delay` value in `config.json`.
- Make sure your GitHub PAT has the necessary permissions to access public repositories.
- If a chain's data fails to load, ensure it exists in the Cosmos Chain Registry and has a valid `chain.json` file.
- If you're having issues with a specific chain, try running a forced update using `yarn update-chains-force`.

## License

This project is licensed under the MIT License.