const sdk = require("@defillama/sdk");
const abi = require("./abi.json");
const BigNumber = require("bignumber.js");
const { coreTokens } = require("../helper/chain/aptos");
const { getResources } = require("../helper/chain/aptos");
const { getConfig } = require('../helper/cache')
const { unwrapUniswapLPs } = require("../helper/unwrapLPs");
const { transformAvaxAddress,transformBalances } = require("../helper/portedTokens");

async function getProcolAddresses(chain) {
  if (chain === 'avax') {
    return (
      await getConfig('mole/'+chain,
        "https://raw.githubusercontent.com/Mole-Fi/mole-protocol/main/.avalanche_mainnet.json"
      )
    );
  }else if(chain === 'aptos') {
    return (
      await getConfig('mole/'+chain,
        "https://raw.githubusercontent.com/Mole-Fi/mole-protocol/main/.aptos_mainnet.json"
      )
    );
  }
}

async function calLyfTvl(chain, block) {
  /// @dev Initialized variables
  const balances = {};
  const transform = await transformAvaxAddress()

  /// @dev Getting all addresses from Github
  const addresses = await getProcolAddresses(chain);

  for (let i = 0; i < addresses["Vaults"].length; i++) {
    /// @dev getting balances that each of workers holding
    const stakingTokenInfos = (
      await sdk.api.abi.multiCall({
        block,
        abi: abi.userInfo,
        calls: addresses["Vaults"][i]["workers"].map((worker) => {
          return {
            target: worker["stakingTokenAt"],
            params: [worker["pId"], worker["address"]],
          };
        }),
        chain,
      })
    ).output;

    /// @dev unwrap LP to get underlaying token balances for workers that are working with LPs
    await unwrapUniswapLPs(
      balances,
      stakingTokenInfos
        .map((info) => {
          /// @dev getting LP address and return the object that unwrapUniswapLPs want
          const lpAddr = addresses["Vaults"][i]["workers"].find(
            (w) => w.address === info.input.params[1]
          ).stakingToken;
          return {
            token: lpAddr,
            balance: info.output.amount,
          };
        }),
      block,
      chain,
      transform
    );
  }

  /// @dev getting all unused liquidity on each vault
  const unusedBTOKEN = (
    await sdk.api.abi.multiCall({
      block,
      abi: abi.balanceOf,
      calls: addresses["Vaults"].map((v) => {
        return {
          target: v["baseToken"],
          params: [v["address"]],
        };
      }),
      chain,
    })
  ).output;

  unusedBTOKEN.forEach((u) => {
    balances[transform(u.input.target.toLowerCase())] = BigNumber(
      balances[transform(u.input.target.toLowerCase())] || 0
    )
      .plus(BigNumber(u.output))
      .toFixed(0);
  });

  return balances;
}

async function calLyfTvlAptos() {
  /// @dev Initialized variables
  const balances = {};

  /// @dev Getting all resources
  const addresses = await getProcolAddresses('aptos');
  const resources = await getResources(addresses.Publisher);

  const lps = {};

  const workers = {}
  addresses.Vaults.flatMap(i => i.workers).map(i => {
    workers[i.address.replace('0x0', '0x')] = true;
  });

  /// @dev getting balances that each of workers holding
  sumPancakeWorkerStakingLps(resources, lps, workers);

  /// @dev unwrap LP to get underlaying token balances for workers that are working with LPs
  await unwrapPancakeSwapLps({
      balances,
      lps,
      account: '0xc7efb4076dbe143cbcd98cfaaa929ecfc8f299203dfff63b95ccb6bfe19850fa',
      poolStr: 'swap::TokenPairReserve',
      token0Reserve: i => i.data.reserve_x,
      token1Reserve: i => i.data.reserve_y
  })

  /// @dev getting all unused liquidity on each vault
  resources.filter(i => i.type.includes("vault::VaultInfo"))
    .map(i => {
      const token = i.type.split('<')[1].replace('>','');
      sdk.util.sumSingleBalance(balances, token, new BigNumber(i.data.coin.value).minus(i.data.reserve_pool).toFixed(0))
    })

  return transformBalances('aptos', balances)
}

function sumPancakeWorkerStakingLps(resources, lps, workers) {
  const workerInfos = resources.filter(i =>
    (
      i.type.includes("pancake_worker::WorkerInfo") ||
      i.type.includes("delta_neutral_pancake_asset_worker::WorkerInfo") ||
      i.type.includes("delta_neutral_pancake_stable_worker::WorkerInfo")
    ) && workers[i.type.split('::',1)[0]]
  )

  workerInfos.forEach(i => {
    let lpWithSuffix = i.type.split(", ");
    lpWithSuffix = lpWithSuffix.splice(2, lpWithSuffix.length - 2).join(", ");
    const lp = lpWithSuffix.substr(0, lpWithSuffix.length - 1);
    const amount = new BigNumber(i.data.total_balance ?? i.data.total_lp_balance)

    if(lps[lp] === undefined) {
      lps[lp] = { amount: amount }
    } else {
      lps[lp].amount = lps[lp].amount.plus(amount);
    }
  })
}

async function unwrapPancakeSwapLps({
  balances,
  lps,
  account,
  poolStr,
  token0Reserve = i => i.data.coin_x_reserve.value,
  token1Reserve = i => i.data.coin_y_reserve.value,
  getTokens = i => i.type.split('<')[1].replace('>', '').split(', ')
}){
  const coinInfos = {}
  const lpReserves = {}
  for (const lpType in lps) {
    if(lps.hasOwnProperty(lpType)){
      coinInfos[`0x1::coin::CoinInfo<${lpType}>`] = lpType;
      const tokens = getTokens({type: lpType})
      lpReserves[`${account}::${poolStr}<${tokens[0]}, ${tokens[1]}>`] = lpType;
    }
  }

  let pools = await getResources(account);
  let lpInfos = pools;
  pools = pools.filter((i) => {
    if(!i.type.includes(poolStr)){
      return false
    }

    i.lpType = lpReserves[i.type]
    return i.lpType !== undefined;
  });
  lpInfos.forEach(i => {
    const lpType = coinInfos[i.type];
    if(lpType){
      lps[lpType].totalSupply = new BigNumber(i.data.supply.vec[0].integer.vec[0].value)
    }
  });

  pools.forEach(i => {
    const reserve0 = token0Reserve(i)
    const reserve1 = token1Reserve(i)
    const [token0, token1] = getTokens(i)
    const isCoreAsset0 = coreTokens.includes(token0)
    const isCoreAsset1 = coreTokens.includes(token1)
    const nonNeglibleReserves = reserve0 !== '0' && reserve1 !== '0'
    const lp = lps[i.lpType];
    const balance0 = new BigNumber(reserve0).times(lp.amount).div(lp.totalSupply).toFixed(0);
    const balance1 = new BigNumber(reserve1).times(lp.amount).div(lp.totalSupply).toFixed(0);
    if (isCoreAsset0 && isCoreAsset1) {
      sdk.util.sumSingleBalance(balances, token0, balance0)
      sdk.util.sumSingleBalance(balances, token1, balance1)
    } else if (isCoreAsset0) {
      sdk.util.sumSingleBalance(balances, token0, balance0)
      if (nonNeglibleReserves)
        sdk.util.sumSingleBalance(balances, token0, balance0)
    } else if (isCoreAsset1) {
      sdk.util.sumSingleBalance(balances, token1, balance1)
      if (nonNeglibleReserves)
        sdk.util.sumSingleBalance(balances, token1, balance1)
    }
  })
}

module.exports = {
  calLyfTvl,
  calLyfTvlAptos
}
  