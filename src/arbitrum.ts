import * as dotenv from "dotenv";
import { ethers} from "ethers";
import {COMPOUNDER_CONTRACT_ADDRESS, COMPOUNDER_ABI, FEE} from "./constants"
import {tokenToAuto} from '@thanpolas/crypto-utils';
import axios from "axios";

dotenv.config();

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_ARBITRUM)
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
const contract = new ethers.Contract(COMPOUNDER_CONTRACT_ADDRESS, COMPOUNDER_ABI, provider)

async function getTokens() {
    const graphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/compounderfi-arbitrium";
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
    const graphURL = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-arbitrum";
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

  shouldTakeToken0: Boolean;
  shouldCompound: Boolean;
  gasThreshold: number;

  profitToken0: number;
  profitToken1: number;

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
      console.log("failed to compound position " + this.tokenID);
      return false;
    }
    const fees0InDecimal = parseFloat(tokenToAuto(this.token0callerfees, this.token0Decimals, {decimalPlaces: this.token0Decimals}));
    this.fee0InEth = fees0InDecimal * this.price0;

    const fees1InDecimal = parseFloat(tokenToAuto(this.token1callerfees, this.token1Decimals, {decimalPlaces: this.token1Decimals}));
    this.fee1InEth = fees1InDecimal * this.price1;
    
    /*
    this.gasPriceWei = (await provider.getGasPrice()).toNumber();
    */
    return true;
  }

  async estimateGasArbitrum(tokenID: number, token0AsFee: boolean) {
    const gasLimit = await contract.connect(signer).estimateGas.compound(tokenID, token0AsFee);
    const gasPrice = (await provider.getGasPrice()).toNumber();
    const gasEstimate = gasLimit.mul(gasPrice);

    return parseFloat(tokenToAuto(gasEstimate.toString(), 18, {decimalPlaces: 18}));
  }
  async getCallableGas() {
    try {
      this.gasEstimateToken0AsFee = await this.estimateGasArbitrum(this.tokenID, true);
      this.gasEstimateToken1AsFee = await this.estimateGasArbitrum(this.tokenID, false);
    } catch(e) {
      console.log(e);
      return false;
    }

    this.gasEstimateToken0AsFee *= FEE; //account for compounding risk, as well as changes in gas
    this.gasEstimateToken1AsFee *= FEE;
    /*
    const estimatedCostToken0AsFee = parseFloat(ethers.utils.formatEther(this.gasLimitToken0AsFee * this.gasPriceWei));
    const estimatedCostToken1AsFee = parseFloat(ethers.utils.formatEther(this.gasLimitToken1AsFee * this.gasPriceWei));
    */
    this.profitToken0 = this.fee0InEth - this.gasEstimateToken0AsFee;
    this.profitToken1 = this.fee1InEth - this.gasEstimateToken1AsFee;
    
    this.shouldTakeToken0 = this.profitToken0 > this.profitToken1;

    if (this.profitToken0 > 0 || this.profitToken1 > 0) {
      this.shouldCompound = true;
    } else {
      this.shouldCompound = false;
    }

    return true;
  }

  async sendTXN() {
    try {
      console.log("sending txn for tokenID: " + this.tokenID)
      await contract.connect(signer).compound(this.tokenID, this.shouldTakeToken0)
    } catch(e) {
      console.log("failed to send txn for tokenID: " + this.tokenID);
      return false;
    }
    return true;
  }
}

async function updatePositions() {
  const [positions, uniqueTokens] = await getTokens();

  const prices = await getPrices(uniqueTokens);

  for(const position of positions) {
    const token0Price = prices[position.token0Address];
    const token1Price = prices[position.token1Address];
    const call = new Call(position.tokenId, token0Price, token1Price, position.token0Decimals, position.token1Decimals);
    if (await call.getFees() && await call.getCallableGas()) {
      console.log(call)

      if (call.shouldCompound) {
        await call.sendTXN();
        call.shouldCompound = false
      }
      
      await new Promise(r => setTimeout(r, 3000)); //wait 3 seconds
    }

  }
}

async function main() {

    setInterval(async () => {
      await updatePositions();
    }, 10 * 60 * 1000 //refresh positions every 10 minutes
    )

    await updatePositions();
    
    
}

main()