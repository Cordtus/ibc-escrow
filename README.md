# IBC Escrow Auditor

This tool performs an IBC escrow audit between two Cosmos chains, verifying the balances of IBC tokens in escrow accounts.

## Features

- Interactive CLI for easy chain selection and audit type choice
- Quick audit for native tokens of both chains simultaneously
- Comprehensive audit with recursive unwrapping of IBC tokens
- Manual channel ID input for custom audits
- Automatic fetching and caching of chain data from the Cosmos Chain Registry
- Detailed logging for troubleshooting and monitoring
- Optimized IBC supply fetching with fallback mechanisms

## Prerequisites

- Node.js (v14 or later)
- Yarn (v1.22 or later)

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

3. (Optional) Create a `.env` file in the root directory and add your GitHub PAT to increase API rate limits:
   ```
   GITHUB_PAT=your_github_personal_access_token_here
   ```

## Usage

Run the audit tool:

```
yarn start
```

This will start the interactive CLI, guiding you through the following steps:

1. Select the primary chain
2. Select the secondary chain
3. Choose the audit type (Quick, Comprehensive, or Manual Channel ID)
4. View the audit results for both chains

### Audit Types

- **Quick**: Audits the native tokens of both chains simultaneously
- **Comprehensive**: Audits all tokens in the escrow accounts, including recursive unwrapping of IBC tokens
- **Manual Channel ID**: Allows you to input a specific channel ID and fetches relevant IBC information

### Other Commands

- Update chain data:
  ```
  yarn update-chains
  ```

- Force update of all chain data:
  ```
  yarn update-chains-force
  ```

## Configuration

Adjust settings in `config.json` to customize the tool's behavior. (Configuration options remain the same as in the previous version)

## Logging

Logs are written to the console and to log files in the `logs` directory:

- `error.log`: Contains only error messages
- `combined.log`: Contains all log messages

You can adjust the logging levels in the `config.json` file.

## Troubleshooting

- If you encounter rate limiting issues, increase the `delay` value in `config.json` or use a GitHub PAT.
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
