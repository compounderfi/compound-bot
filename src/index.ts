import * as dotenv from "dotenv";
import { BigNumber, ethers} from "ethers";
import {COMPOUNDER_CONTRACT_ADDRESS, NFPM_ADDRESS, NFPM_ABI, COMPOUNDER_ABI, FEE, CHAINLINK_MATIC_ETH, CHAINLINK_ABI, GAS_LIMIT_BUFFER} from "./constants"
import {tokenToAuto} from '@thanpolas/crypto-utils';
import axios from "axios";
const optimismSDK = require("@eth-optimism/sdk")

dotenv.config();

let provider: ethers.providers.JsonRpcProvider;
let compounderGraphURL: string;
let uniswapGraphUrl: string;

if (process.argv[2] && process.argv[2] === '-o') {
  provider = optimismSDK.asL2Provider(new ethers.providers.JsonRpcProvider(process.env.RPC_OPTIMISM))
  compounderGraphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/compounderfi-optimism";
  uniswapGraphUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-optimism";
} else if (process.argv[2] && process.argv[2] === '-a') {
  provider =  new ethers.providers.JsonRpcProvider(process.env.RPC_ARBITRUM)
  compounderGraphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/compounderfi-arbitrium";
  uniswapGraphUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-arbitrum";
} else if (process.argv[2] && process.argv[2] === '-p') {
  provider =  new ethers.providers.JsonRpcProvider(process.env.RPC_POLYGON)
  compounderGraphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/compounderfi-polygon";
  uniswapGraphUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-polygon";
} else {
  provider =  new ethers.providers.JsonRpcProvider(process.env.RPC_MAINNET)
  compounderGraphURL = "https://api.thegraph.com/subgraphs/name/compounderfi/compounderfi-mainnet";
  uniswapGraphUrl = "https://api.thegraph.com/subgraphs/name/revert-finance/uniswap-v3-mainnet";
}



const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider)
const contract = new ethers.Contract(COMPOUNDER_CONTRACT_ADDRESS, COMPOUNDER_ABI, provider)
const chainlink = new ethers.Contract(CHAINLINK_MATIC_ETH, CHAINLINK_ABI, provider)
const NFPM = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, provider)

async function getTokens() {
    const resp = await axios.post(compounderGraphURL, {
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
    const resp = await axios.post(uniswapGraphUrl, {
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

async function getPolygonGas() {
  // get max fees from gas station
  let maxFeePerGas = ethers.BigNumber.from(100000000000) // fallback to 100 gwei
  let maxPriorityFeePerGas = ethers.BigNumber.from(40000000000) // fallback to 40 gwei
  try {
      const { data } = await axios({
          method: 'get',
          url: 'https://gasstation-mainnet.matic.network/v2'
      })
      maxFeePerGas = ethers.utils.parseUnits(
          Math.ceil(data.fast.maxFee) + '',
          'gwei'
      )
      maxPriorityFeePerGas = ethers.utils.parseUnits(
          Math.ceil(data.fast.maxPriorityFee) + '',
          'gwei'
      )
  } catch {
      // ignore
  }
  return [maxFeePerGas, maxPriorityFeePerGas]
}

async function hasLiquidity(tokenId: number) {
  const positionDetails = await NFPM.positions(tokenId);
  const liq = positionDetails.liquidity;

  return liq.gt(0)
  
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

  gasEstimateToken0AsFee: number; //gas estimate in total - gas limit * gas price
  gasEstimateToken1AsFee: number;
  
  gasLimitEstimate0asFee: number;
  gasLimitEstimate1asFee: number;

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
      console.log(e)
      return false;
    }
    const fees0InDecimal = parseFloat(tokenToAuto(this.token0callerfees, this.token0Decimals, {decimalPlaces: this.token0Decimals}));
    this.fee0InEth = fees0InDecimal * this.price0;

    const fees1InDecimal = parseFloat(tokenToAuto(this.token1callerfees, this.token1Decimals, {decimalPlaces: this.token1Decimals}));
    this.fee1InEth = fees1InDecimal * this.price1;
    

    return true;
  }

  
  async estimateGas(tokenID: number, token0AsFee: boolean) {
    const gasLimit = await contract.connect(signer).estimateGas.compound(tokenID, token0AsFee);
    const gasPrice = await provider.getGasPrice();
    const gasEstimate = gasLimit.mul(gasPrice);
    
    //if polygon
    if (process.argv[2] && process.argv[2] === '-p') {
      //we multiply MATIC/ETH price because fees are paid in MATIC
      //gasEstimate in this case, is in MATIC
      const maticEthPrice = await chainlink.latestAnswer();
      const gasEstimateInEth = gasEstimate.mul(maticEthPrice)
      return [parseFloat(tokenToAuto(gasEstimateInEth.toString(), 36, {decimalPlaces: 18})), gasLimit.toNumber()];
      
    }
    
    return [parseFloat(tokenToAuto(gasEstimate.toString(), 18, {decimalPlaces: 18})), gasLimit.toNumber()];
  }

  async estimateGasOptimism(tokenID: number, token0AsFee: boolean) {
    
    const txn = await contract.populateTransaction.compound(tokenID, token0AsFee)
    
    txn.gasPrice = ethers.BigNumber.from( 0 ); //optimism only: doesn't work when gasPrice is estimated for some reason

    const populatedTxn = await signer.populateTransaction(txn)

    //we ignore this because we assume that the provider we will use does have estimateTotalGasCost
    //@ts-ignore
    const gasEstimate = await provider.estimateTotalGasCost(populatedTxn)

    return parseFloat(tokenToAuto(gasEstimate.toString(), 18, {decimalPlaces: 18}));
  }

  async getCallableGas() {
    try {
      if (process.argv[2] && process.argv[2] === '-o') {
        this.gasEstimateToken0AsFee = await this.estimateGasOptimism(this.tokenID, true);
        this.gasEstimateToken1AsFee = await this.estimateGasOptimism(this.tokenID, false);
      } else {

        [this.gasEstimateToken0AsFee, this.gasLimitEstimate0asFee] = await this.estimateGas(this.tokenID, true);
        [this.gasEstimateToken1AsFee, this.gasLimitEstimate1asFee] = await this.estimateGas(this.tokenID, false);
      }
    } catch(e) {
      //console.log(e);
      console.log("cannot estimate gas")
      return false;
    }

    this.gasEstimateToken0AsFee *= FEE; //account for compounding risk, as well as changes in gas
    this.gasEstimateToken1AsFee *= FEE;

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
      //if not polygon
      if (!(process.argv[2] && process.argv[2] === '-p')) {
        await contract.connect(signer).compound(this.tokenID, this.shouldTakeToken0, {
          gasLimit: this.shouldTakeToken0 ?
            this.gasLimitEstimate0asFee + GAS_LIMIT_BUFFER :
            this.gasLimitEstimate1asFee + GAS_LIMIT_BUFFER
          })
      } else {
        //if polygon
        let maxFeePerGas;
        let maxPriorityFeePerGas;
        [maxFeePerGas, maxPriorityFeePerGas] = await getPolygonGas();
        await contract.connect(signer).compound(this.tokenID, this.shouldTakeToken0, {
          maxFeePerGas: maxFeePerGas,
          maxPriorityFeePerGas: maxPriorityFeePerGas,
          gasLimit: this.shouldTakeToken0 ?
            this.gasLimitEstimate0asFee + GAS_LIMIT_BUFFER :
            this.gasLimitEstimate1asFee + GAS_LIMIT_BUFFER
          
        })
      }

    } catch(e) {
      //console.log(e)
      console.log("failed to send txn for tokenID: " + this.tokenID);
      return false;
    }
    return true;
  }
}

const noLiquidityPositions = <number[]>[]
const hasLiquidityPositions = <number[]>[]

async function updatePositions() {
  const [positions, uniqueTokens] = await getTokens();

  const prices = await getPrices(uniqueTokens);
  for(const position of positions) {
    if (!noLiquidityPositions.includes(position.tokenId) || hasLiquidityPositions.includes(position.tokenId)) {
      if (await hasLiquidity(position.tokenId)) {
        hasLiquidityPositions.push(position.tokenId);

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
      } else {
        noLiquidityPositions.push(position.tokenId);
      }

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