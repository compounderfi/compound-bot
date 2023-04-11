# compound-bot
Nodejs bot that runs the compound function at low gas

Make sure you have npm installed.

Then do:
```
npm install -g typescript
npm i
```

Then compile index.ts
```
tsc src/index.ts
```

## Configuration
Replace the `.env.example` with `.env` with your correct node urls and private key.

You should also the fee in `constants.ts` to your liking.

## Selecting network to compound
Here are the following flags and the supported networks (after you compile your ts into js):

Ethereum:
```
node src/index.js -e
```

Polygon
```
node src/index.js -p
```

Arbitrum
```
node src/index.js -a
```

Optimism
```
node src/index.js -o
```