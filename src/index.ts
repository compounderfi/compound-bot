import * as dotenv from 'dotenv'
import { ethers, Contract } from "ethers";
import abi from "./abis/compounder.json";
import {tokenToAuto} from '@thanpolas/crypto-utils';
import { Alchemy, Network } from "alchemy-sdk";

const axios = require('axios').default;

dotenv.config()

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
const contract = new ethers.Contract("0x979d7E9CdE9a270276495f9054923cFdA8Db0E09", abi, provider)

async function getTokens() {
    const graphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/test1";
    const resp = await axios.post(graphURL, {
      query: `
      {
        positions(where: {tokenWithdraw: null}, first: 1000) {
          id
          token0 {
            id
            decimals
          }
          token1 {
            id
            decimals
          }
        }
      }
                `,
      variables: null,
    });

    const positions = resp.data["data"]["positions"];
    const positionList = []
    const tokens = new Set();

    for (let i = 0; i < positions.length; i++) {
        tokens.add(positions[i]["token0"]["id"]);
        tokens.add(positions[i]["token1"]["id"]);
        positionList.push(
            {
                tokenId: positions[i]["id"],
                token0Address: positions[i]["token0"]["id"],
                token0Decimals: parseInt(positions[i]["token0"]["decimals"]),
                token1Address: positions[i]["token1"]["id"],
                token1Decimals: parseInt(positions[i]["token1"]["decimals"])
            }
        )
    }
    //positionList - array of [tokenId, token0address, token1address, decimals0, decimals1]
    return [positionList, Array.from(tokens)]
}


async function getPrices(uniqueTokens) {
    const graphURL = "https://api.thegraph.com/subgraphs/name/compositelabs/uniswap-v3-goerli";
    const resp = await axios.post(graphURL, {
        query: `
        {
            tokens(where: {id_in: ${JSON.stringify(uniqueTokens)}}) {
              id
              derivedETH
            }
        }
                  `,
        variables: null,
      });
    const prices = resp.data["data"]["tokens"]
    const tokenToPrice = new Object();

    for(let i = 0; i < prices.length; i++) {
        tokenToPrice[prices[i]["id"]] = parseFloat(prices[i]["derivedETH"]);
    }
    return tokenToPrice
}

class Call {
  tokenID: Number;
  price0: Number;
  price1:Number;
  token0Decimals: Number;
  token1Decimals:Number;

  fees0: Number;
  fees1: Number;
  fees0Swap: Number;
  fees1Swap: Number;
  //token - true: token0, false: token1
  constructor(tokenID: Number, price0: Number, price1:Number, token0Decimals: Number, token1Decimals:Number) {
    this.tokenID = tokenID;
    this.price0 = price0;
    this.price1 = price1;
    this.token0Decimals = token0Decimals;
    this.token1Decimals = token1Decimals;

  }

  async getFees() {
    const token0callerfees = (await contract.connect(signer).callStatic.autoCompound([this.tokenID, true, false]))["fee0"].toString();

    const fees0InDecimal = parseFloat(tokenToAuto(token0callerfees, this.token0Decimals, {decimalPlaces: this.token0Decimals}));
    const token0PriceEth = 0.034234325534//prices[position.token0Address];
    const fee0InEth = fees0InDecimal * token0PriceEth;

    const token1callerfees = (await contract.connect(signer).callStatic.autoCompound([this.tokenID, false, false]))["fee1"].toString();

    const fees1InDecimal = parseFloat(tokenToAuto(token1callerfees, this.token1Decimals, {decimalPlaces: this.token1Decimals}));
    const token1PriceEth = 0.2924235435 // prices[position.token1Address];
    const fee1InEth = fees1InDecimal * token1PriceEth;

    this.fees0 = fee0InEth;
    this.fees1 = fee1InEth;
    this.fees0Swap = (fee0InEth * 5)/4
    this.fees1Swap = (fee1InEth * 5)/4
    
  }
}
async function main() {
    
    const [positions, uniqueTokens] = await getTokens();
    const prices = await getPrices(uniqueTokens);

    
        const position = positions[0]
        /*
        const token0callerfees = (await contract.connect(signer).callStatic.autoCompound([position.tokenId, true, false]))["fee0"].toString();

        const fees0InDecimal = parseFloat(tokenToAuto(token0callerfees, position.token0Decimals, {decimalPlaces: position.token0Decimals}));
        const token0PriceEth = 0.034234325534//prices[position.token0Address];
        const fee0InEth = fees0InDecimal * token0PriceEth;

        const token1callerfees = (await contract.connect(signer).callStatic.autoCompound([position.tokenId, false, false]))["fee1"].toString();

        const fees1InDecimal = parseFloat(tokenToAuto(token1callerfees, position.token1Decimals, {decimalPlaces: position.token1Decimals}));
        const token1PriceEth = 0.2924235435 // prices[position.token1Address];
        const fee1InEth = fees1InDecimal * token1PriceEth;

        const costToRecieve0 = await contract.connect(signer).estimateGas.autoCompound([position.tokenId, true, false]);
        const costToRecieve1 = await contract.connect(signer).estimateGas.autoCompound([position.tokenId, false, false]);
        const x = await contract.connect(signer).estimateGas.autoCompound([position.tokenId, true, true]);
        const y = await contract.connect(signer).estimateGas.autoCompound([position.tokenId, false, true]);

        console.log(costToRecieve0.toNumber(), costToRecieve1.toNumber(), x.toNumber(), y.toNumber())
        console.log(fee0InEth, fee1InEth)
        */

   

    /*
    const settings = {
        apiKey: process.env.ALCHEMY_API_KEY, // Replace with your Alchemy API Key.
        network: Network.ETH_MAINNET, // Replace with your network.
    };

    const alchemy = new Alchemy(settings);

    // Subscription for new blocks on Eth Mainnet.
    alchemy.ws.on("block", async (blockNumber) => {
      console.log("The latest block number is", blockNumber);
      const gas = await provider.getFeeData();
      const a = gas["lastBaseFeePerGas"].toNumber()
      const b = gas["maxFeePerGas"].toNumber()
      const c = gas["maxPriorityFeePerGas"].toNumber()
      const d = gas["gasPrice"].toNumber()
      console.log(a, b, c, d)
    }
    );
    */
}

main()