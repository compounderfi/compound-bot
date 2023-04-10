import * as dotenv from "dotenv";
import { ethers, Contract, BigNumber } from "ethers";
import {COMPOUNDER_CONTRACT_ADDRESS, NFPM_ADDRESS, COMPOUNDER_ABI} from "./test"
import {tokenToAuto} from '@thanpolas/crypto-utils';
import { Alchemy, Network } from "alchemy-sdk";
import axios from "axios";
const optimismSDK = require("@eth-optimism/sdk")

dotenv.config();

const l2RpcProvider = optimismSDK.asL2Provider(
  new ethers.providers.JsonRpcProvider(process.env.RPC_OPTIMISM)
)

const signer = new ethers.Wallet(process.env.PRIVATE_KEY, l2RpcProvider)
const contract = new ethers.Contract(COMPOUNDER_CONTRACT_ADDRESS, COMPOUNDER_ABI, l2RpcProvider)
const standardDecimals = ethers.BigNumber.from(10).pow(18);

async function getTokens() {
    const graphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/compounderfi-optimism";
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
    const graphURL = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-optimism";
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

  fee0InEth: number;
  fee1InEth: number;

  token0callerfees: String;
  token1callerfees: String;

  maxGwei: number;

  gasEstimateToken0AsFee: number; //gas estimate in total - gas limit * gas price
  gasEstimateToken1AsFee: number;

  gasPriceWei: number;

  shouldTakeToken0: Boolean;
  shouldCompound: Boolean;
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
      this.token0callerfees = (await contract.connect(signer).callStatic.compound(this.tokenID, true))["fee0"].toString();
      this.token1callerfees = (await contract.connect(signer).callStatic.compound(this.tokenID, false))["fee1"].toString();
    } catch(e) {
      console.log(e)
      return false;
    }
    const fees0InDecimal = parseFloat(tokenToAuto(this.token0callerfees, this.token0Decimals, {decimalPlaces: this.token0Decimals}));
    this.fee0InEth = fees0InDecimal * this.price0;

    const fees1InDecimal = parseFloat(tokenToAuto(this.token1callerfees, this.token1Decimals, {decimalPlaces: this.token1Decimals}));
    this.fee1InEth = fees1InDecimal * this.price1;
    
    /*
    this.gasPriceWei = (await l2RpcProvider.getGasPrice()).toNumber();
    */
    return true;
  }

  async estimateGasOptimism(tokenID: number, token0AsFee: boolean) {
    const txn = await contract.populateTransaction.compound(tokenID, token0AsFee)
    
    txn.gasPrice = ethers.BigNumber.from( 0 ); //optimism only: doesn't work when gasPrice is estimated for some reason

    const populatedTxn = await signer.populateTransaction(txn)
    const gasEstimate = await l2RpcProvider.estimateTotalGasCost(populatedTxn)

    return parseFloat(tokenToAuto(gasEstimate.toString(), 18, {decimalPlaces: 18}));
  }
  async getCallableGas() {
    try {
      this.gasEstimateToken0AsFee = await this.estimateGasOptimism(this.tokenID, true);
      this.gasEstimateToken1AsFee = await this.estimateGasOptimism(this.tokenID, false);
    } catch(e) {
      console.log(e);
      return false;
    }

    this.gasEstimateToken0AsFee *= 1.25; //account for compounding risk, as well as changes in gas
    this.gasEstimateToken1AsFee *= 1.25;
    /*
    const estimatedCostToken0AsFee = parseFloat(ethers.utils.formatEther(this.gasLimitToken0AsFee * this.gasPriceWei));
    const estimatedCostToken1AsFee = parseFloat(ethers.utils.formatEther(this.gasLimitToken1AsFee * this.gasPriceWei));
    */
    const profitToken0 = this.fee0InEth - this.gasEstimateToken0AsFee;
    const profitToken1 = this.fee1InEth - this.gasEstimateToken1AsFee;
    
    this.shouldTakeToken0 = profitToken0 > profitToken1;

    if (profitToken0 > 0 || profitToken1 > 0) {
      this.shouldCompound = true;
    } else {
      this.shouldCompound = false;
    }
    
    /*
    if (this.shouldTakeToken0) {
      const gasLimitEstimate0 = this.gasLimitToken0AsFee * 1.1
      this.gasThreshold = (this.fee0InEth / gasLimitEstimate0) * 10 ** 18;
    } else {
      const gasLimitEstimate1 = this.fee1InEth * 1.1
      this.gasThreshold = (this.fee1InEth / gasLimitEstimate1) * 10 ** 18;
    }*/

    return true;
  }
/*
  async ensureFees() {
    let currentFee0: BigNumber;
    let currentFee1: BigNumber;
    try {
      currentFee0 = (await contract.connect(signer).callStatic.compound(this.tokenID, true))["fee0"];
      currentFee1 = (await contract.connect(signer).callStatic.compound(this.tokenID, false))["fee1"];
    } catch(e) {
      console.log(e);
      return false;
    }

    const pastFee0 = BigNumber.from(this.token0callerfees);

    const pastFee1 = BigNumber.from(this.token1callerfees);
    console.log(currentFee0.gte(pastFee0), currentFee1.gte(pastFee1))
    return currentFee0.gte(pastFee0) && currentFee1.gte(pastFee1);
  }
*/
  async sendTXN() {
    try {
      console.log("sending txn for tokenID: " + this.tokenID)
      //await contract.connect(signer).compound(this.tokenID, this.token, )
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

  const tempCalls: Call[] = [];
  for(const position of positions) {
    const token0Price = prices[position.token0Address];
    const token1Price = prices[position.token1Address];
    const call = new Call(position.tokenId, token0Price, token1Price, position.token0Decimals, position.token1Decimals);
    if (await call.getFees() && await call.getCallableGas()) {
      tempCalls.push(call)

      if (call.shouldCompound) {
        await call.sendTXN();
        call.shouldCompound = false
      }
      
      console.log(call)
      await new Promise(r => setTimeout(r, 3000)); //wait 3 seconds
    }

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
      if (calls.length > 0)
      console.log(calls)
    })
    
    await updatePositions();
    //const poszero = new Call(position.tokenId, prices[position.token0Address], prices[position.token1Address], position.token0Decimals, position.token1Decimals);

    /*
    const settings = {
        apiKey: process.env.ALCHEMY_API_KEY, // Replace with your Alchemy API Key.
        network: Network.OPT_MAINNET, // Replace with your network.
    };

    const alchemy = new Alchemy(settings);

    // Subscription for new blocks on Eth Mainnet.
    alchemy.ws.on("block", async (blockNumber) => {
      //console.log("The latest block number is", blockNumber);
      const gas = await provider.getFeeData();
      const a = gas["lastBaseFeePerGas"].toNumber()
      const b = gas["maxFeePerGas"].toNumber()
      const c = gas["maxPriorityFeePerGas"].toNumber()
      const d = gas["gasPrice"].toNumber()
      //console.log(a, b, c, d)
    }
    );
    */
    
}

main()