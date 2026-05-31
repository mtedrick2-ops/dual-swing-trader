# Dual Swing Trader

Two-model automated swing trading system.

- **TREND Model** — Forex, Gold, Oil, Bitcoin (Video 1 rules: 50 EMA + Fibonacci pullback)
- **BREAKOUT Model** — US Stocks (Video 2 rules: High tight flag breakout)

## Data Sources
- OANDA API — Forex, Gold, Oil, NASDAQ futures
- CoinGecko API — Bitcoin
- Polygon.io — US Stocks

## Setup
1. Clone this repo
2. Run `npm install`
3. Run `npm start`
4. Enter your Anthropic API key in the dashboard

## Deploy
Deployed via Vercel — push to main branch to auto-deploy.
