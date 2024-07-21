# IBC Escrow Audit Tool

This tool performs an IBC escrow audit between two Cosmos chains, verifying the balances of IBC tokens in escrow accounts.

## Features

- Interactive CLI for easy chain selection and audit type choice
- Quick audit for native tokens
- Comprehensive audit with recursive unwrapping of IBC tokens
- Automatic fetching and caching of chain data from the Cosmos Chain Registry
- Detailed logging for troubleshooting and monitoring

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

This will start the interactive CLI, guiding you through chain selection and audit type choice.

### Other Commands

- Update chain data:
  ```
  yarn update-chains
  ```

- Force update of all chain data:
  ```
  yarn update-chains-force
  ```

- Run a quick audit directly:
  ```
  yarn quick
  ```

- Run a comprehensive audit directly:
  ```
  yarn comprehensive
  ```

## Configuration

Adjust settings in `config.json` to customize the tool's behavior, including:

- API retry settings
- Logging configuration
- Default audit type
- File paths

## Logging

Logs are written to the console and to log files in the `logs` directory:
- `error.log`: Contains only error messages
- `combined.log`: Contains all log messages

## Troubleshooting

- If you encounter rate limiting issues, check the `delay` value in `config.json` or use a GitHub PAT.
- Ensure the chains you're auditing exist in the Cosmos Chain Registry.
- For issues with specific chains, try running a forced update using `yarn update-chains-force`.
- Check the log files for detailed information about any errors.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.