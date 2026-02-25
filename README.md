# Lisk RedStone Oracle Keeper

A [Goldsky Compose](https://docs.goldsky.com/compose) app that keeps RedStone oracle price feeds up-to-date on Lisk mainnet. Runs a cron job every minute that checks feed deviation (>= 0.5%) and staleness (>= 6 hours), and pushes updates on-chain when needed.

## Prerequisites

- [Goldsky CLI](https://docs.goldsky.com/get-started/cli) installed and authenticated
- Node.js (for `npm install`)
- A funded wallet on Lisk mainnet (the keeper's private key)

## Setup

1. Install dependencies:

```sh
npm install
```

2. Set the keeper secret (this is the private key of the wallet that will submit transactions):

```sh
goldsky compose secret set KEEPER_PRIVATE_KEY <your-private-key>
```

3. Deploy:

```sh
goldsky compose deploy
```

## Configuration

All configuration is in `compose.yaml`. Key environment variables:

| Variable | Description |
|---|---|
| `ORACLE_ADDRESS` | RedStone oracle contract on Lisk |
| `TARGET_ADDRESS` | Target contract address |
| `SYMBOLS` | Comma-separated price feed symbols (e.g. `ETH,LSK,USDT`) |
| `MIN_DEVIATION_PERCENT` | Minimum price deviation to trigger an update (default `0.5`) |
| `MIN_TIME_ELAPSED_HOURS` | Maximum staleness before forcing an update (default `6`) |
| `LISK_RPC_URL` | Lisk RPC endpoint |

## How it works

Every minute, the task:

1. Fetches live prices from RedStone's data service
2. Reads stored on-chain prices via Multicall3
3. Compares deviation and staleness against thresholds
4. Submits an `updateDataFeedsValuesPartial` transaction for any feeds that need updating
