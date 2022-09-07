import * as dotenv from 'dotenv'
import { ethers, Contract, BigNumber } from "ethers";
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
  tokenID: number;
  price0: number;
  price1: number;
  token0Decimals: number;
  token1Decimals:number;

  token0callerfees: String;
  token1callerfees: String;

  token: Boolean; //token - true: token0, false: token1
  callerFeesNoSwap: number;
  callerFeesSwap: number;
  maxGwei: number;

  gasLimitNoSwap: BigNumber;
  gasLimitSwap: BigNumber;

  gasPriceWei: BigNumber;

  doSwap: Boolean;

  gasThreshold: number;

  constructor(tokenID: number, price0: number, price1:number, token0Decimals: number, token1Decimals:number) {
    this.tokenID = tokenID;
    this.price0 = price0;
    this.price1 = price1;
    this.token0Decimals = token0Decimals;
    this.token1Decimals = token1Decimals;

  }

  async getFees() {
    try {
      this.token0callerfees = (await contract.connect(signer).callStatic.autoCompound([this.tokenID, true, false]))["fee0"].toString();
      this.token1callerfees = (await contract.connect(signer).callStatic.autoCompound([this.tokenID, false, false]))["fee1"].toString();
    } catch(e) {
      console.log(e)
      return false;
    }
    const fees0InDecimal = parseFloat(tokenToAuto(this.token0callerfees, this.token0Decimals, {decimalPlaces: this.token0Decimals}));
    const fee0InEth = fees0InDecimal * this.price0;

    const fees1InDecimal = parseFloat(tokenToAuto(this.token1callerfees, this.token1Decimals, {decimalPlaces: this.token1Decimals}));
    const fee1InEth = fees1InDecimal * this.price1;

    this.token = fee0InEth > fee1InEth;
    if (fee0InEth > fee1InEth) {
      this.callerFeesNoSwap = fee0InEth;
      this.callerFeesSwap = fee0InEth * 1.25;
      this.token = true;
    } else {
      this.callerFeesNoSwap = fee1InEth;
      this.callerFeesSwap = fee1InEth * 1.25;
      this.token = false;
    }

    this.gasPriceWei = await provider.getGasPrice();
    return true;
  }

  async getCallableGas() {
    try {
      this.gasLimitNoSwap = (await contract.connect(signer).estimateGas.autoCompound([this.tokenID, this.token, false])).add(15000);
      this.gasLimitSwap = (await contract.connect(signer).estimateGas.autoCompound([this.tokenID, this.token, true])).add(15000);
    } catch(e) {
      console.log(e);
      return false;
    }
    const estimatedCostNoSwap = parseFloat(ethers.utils.formatEther(this.gasLimitNoSwap.mul(this.gasPriceWei)));
    const estimatedCostSwap = parseFloat(ethers.utils.formatEther(this.gasLimitSwap.mul(this.gasPriceWei)));

    const profitNoSwap = this.callerFeesNoSwap - estimatedCostNoSwap;
    const profitSwap = this.callerFeesSwap - estimatedCostSwap;

    this.doSwap = profitSwap > profitNoSwap;

    if (this.doSwap) {
      const threshold = this.callerFeesSwap * 1.15
      this.gasThreshold = (threshold / this.gasLimitSwap.toNumber()) * 10 ** 18;
    } else {
      const threshold = this.callerFeesNoSwap * 1.15
      this.gasThreshold = (threshold / this.gasLimitNoSwap.toNumber()) * 10 ** 18;
    }

    return true;
  }

  async ensureFees() {
    let currentFee0: BigNumber;
    let currentFee1: BigNumber;
    try {
      currentFee0 = (await contract.connect(signer).callStatic.autoCompound([this.tokenID, true, false]))["fee0"];
      currentFee1 = (await contract.connect(signer).callStatic.autoCompound([this.tokenID, false, false]))["fee1"];
    } catch(e) {
      console.log(e);
      return false;
    }

    const pastFee0 = BigNumber.from(this.token0callerfees);

    const pastFee1 = BigNumber.from(this.token1callerfees);
    console.log(currentFee0.gte(pastFee0), currentFee1.gte(pastFee1))
    return currentFee0.gte(pastFee0) && currentFee1.gte(pastFee1);
  }

  async sendTXN() {
    const shouldCompound = await this.ensureFees();
    if (!shouldCompound) return false

    try {
      await contract.connect(signer).autoCompound([this.tokenID, this.token, this.doSwap], {gasLimit: this.doSwap ? this.gasLimitSwap : this.gasLimitNoSwap})
    } catch(e) {
      console.log(e);
      return false;
    }
    return true;
  }
}

async function updatePositions() {
  const [positions, uniqueTokens] = await getTokens();
  const prices = await getPrices(uniqueTokens);
  
  const tempCalls: Call[] = []
  for(const position of positions) {
    const call = new Call(position.tokenId, 200000, 200000, position.token0Decimals, position.token1Decimals);
    const isWorking = await call.getFees(); //checks to see if the position can be compounded
    if (isWorking) {
      await call.getCallableGas();
    }

    tempCalls.push(call)

  }
  return tempCalls;
}
async function main() {
    let calls: Call[] = []
    setInterval(async () => {
        calls = await updatePositions();
    }, 10 * 60 * 1000 //refresh positions every 10 minutes
    )
    setInterval(() => {
      console.log(calls)
    })
    await updatePositions();
    //const poszero = new Call(position.tokenId, prices[position.token0Address], prices[position.token1Address], position.token0Decimals, position.token1Decimals);

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