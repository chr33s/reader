# READER

> Feed reader

Simple atom, rss, & html feed reader.

## Setup

```
vi config.json # edit
echo "WEBHOOK_URL='your webhook url'" >> .env
echo "TOKEN='$(openssl rand -base64 48)'" >> .env && npx wrangler secret bulk .env
npx wrangler queues create reader
npx wrangler deploy
```