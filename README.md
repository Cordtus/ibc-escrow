# IBC Escrow Audit Tool

This tool performs an IBC escrow audit between two Cosmos chains, verifying the balances of IBC tokens in escrow accounts.

## Features

- Interactive CLI for easy chain selection and audit type choice
- Quick audit for native tokens
- Comprehensive audit with recursive unwrapping of IBC tokens
- Manual channel ID input for custom audits
- Automatic fetching and caching of chain data from the Cosmos Chain Registry
- Detailed logging for troubleshooting and monitoring
- Option to run reverse audits

## Prerequisites

- Node.js (v14 or later)
- Yarn (v1.22 or later)

## Setup

1. Clone this repository:

   ```sh
   git clone https://github.com/cordtus/ibc-escrow-audit.git
   cd ibc-escrow-audit
   ```

2. Install dependencies:

   ```sh
   yarn install
   ```

3. (Optional) Create a `.env` file in the root directory and add your GitHub PAT to increase API rate limits:

   ```sh
   GITHUB_PAT=your_github_personal_access_token_here
   ```

## Usage

Run the audit tool:

```sh
yarn start
```

This will start the interactive CLI, guiding you through the following steps:

1. Select the primary chain
2. Select the secondary chain
3. Choose the audit type (Quick, Comprehensive, or Manual Channel ID)
4. View the audit results
5. Option to run a reverse audit

### Audit Types

- **Quick**: Audits only the native token of the primary chain
- **Comprehensive**: Audits all tokens in the escrow account, including recursive unwrapping of IBC tokens
- **Manual Channel ID**: Allows you to input a specific channel ID and fetches relevant IBC information

### Other Commands

- Update chain data:

  ```sh
  yarn update-chains
  ```

- Force update of all chain data:

  ```sh
  yarn update-chains-force
  ```

## Configuration

Adjust settings in `config.json` to customize the tool's behavior:

```json
{
  "github": {
    "owner": "cosmos",
    "repo": "chain-registry"
  },
  "api": {
    "retries": 3,
    "delay": 250
  },
  "paths": {
    "dataDir": "data",
    "logsDir": "logs"
  },
  "logging": {
    "level": "info",
    "fileLogLevel": "error"
  },
  "audit": {
    "defaultType": "quick",
    "escrowPort": "transfer"
  }
}
```

## Logging

Logs are written to the console and to log files in the `logs` directory:

- `error.log`: Contains only error messages
- `combined.log`: Contains all log messages

You can adjust the logging levels in the `config.json` file.

## Troubleshooting

- If you encounter rate limiting issues on initialization or when updating chain data, increase the `delay` value in `config.json` or use a GitHub PAT.
- Ensure the chains you're auditing exist in the Cosmos Chain Registry.
- For issues with specific chains, try running a forced update using `yarn update-chains-force`.
- Check the log files for detailed information about any errors.
- If you're having issues with a specific channel, try using the Manual Channel ID audit type.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

- [Cosmos Chain Registry](https://github.com/cosmos/chain-registry) for providing chain data
- [Inquirer.js](https://github.com/SBoudrias/Inquirer.js/) for the interactive CLI
