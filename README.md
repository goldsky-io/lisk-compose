# Lisk RedStone Oracle Keeper

A [Goldsky Compose](https://docs.goldsky.com/compose) app that keeps RedStone oracle price feeds up-to-date on Lisk mainnet. Runs a cron job every minute that checks feed deviation (>= 0.5%) and staleness (>= 6 hours), and pushes updates on-chain when needed.

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/get-started/cli) installed and authenticated
- Node.js >= 20 with npm >= 11.10.0 (for `npm install`)

## Setup

1. Install dependencies:

```sh
npm install
```

2. Deploy:

```sh
goldsky compose deploy
```

The app uses a Compose-managed wallet (`lisk-keeper`) for submitting transactions — no private key secret is needed.

## Configuration

All configuration is in `compose.yaml`. Key environment variables:

| Variable | Description |
|---|---|
| `ORACLE_ADDRESS` | RedStone oracle contract on Lisk |
| `TARGET_ADDRESS` | Target contract address |
| `MULTICALL3_ADDRESS` | Multicall3 contract for batched reads |
| `SYMBOLS` | Comma-separated price feed symbols (e.g. `ETH,LSK,USDT,USDC,WBTC,BTC,wstETH/ETH`) |
| `DATA_SERVICE_ID` | RedStone data service ID (`redstone-primary-prod`) |
| `UNIQUE_SIGNERS_COUNT` | Required number of unique signers per data package |
| `MIN_DEVIATION_PERCENT` | Minimum price deviation to trigger an update (default `0.5`) |
| `MIN_TIME_ELAPSED_HOURS` | Maximum staleness before forcing an update (default `6`) |
| `CHAIN` | Chain name as registered in Compose (e.g. `lisk`) |
| `LISK_RPC_URL` | Lisk RPC endpoint |

## How it works

Every minute, the `update_price_feeds` task:

1. Fetches live prices from RedStone's data service gateways via `context.fetch()`
2. Reads stored on-chain prices via Multicall3 batched calls
3. Compares deviation and staleness against thresholds
4. Submits an `updateDataFeedsValuesPartial` transaction for any feeds that need updating
5. Records update history in a Compose collection for observability
