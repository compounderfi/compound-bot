import * as dotenv from 'dotenv'
import { ethers, Contract } from "ethers";
import abi from "./abis/compounder.json";
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
          }
          token1 {
            id
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
        positionList.push([positions[i]["id"], positions[i]["token0"]["id"], positions[i]["token1"]["id"]])
    }
    return [positionList, tokens]
}

async function getPrices() {

}
async function main() {
    const [tokensIDs, uniqueTokens] = await getTokens();
    

    //const data = await contract.connect(signer).callStatic.autoCompound([token, true, false]);
    
}

main()