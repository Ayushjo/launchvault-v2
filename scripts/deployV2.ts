import hre from "hardhat";

async function main() {
  const conn = await hre.network.connect();
  const ethers = conn.ethers;

  const [deployer, , founder] = await ethers.getSigners();

  // Use the real oracle address (can be any externally-controlled account)
  const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS ?? "0xeF1d8941599c424675Ae03CF641E9ABB3d5ac55e";

  console.log("Deploying with account:", await deployer.getAddress());
  console.log("Oracle address:", ORACLE_ADDRESS);

  // Deploy Factory with custom oracle
  const Factory = await ethers.getContractFactory("CampaignFactoryV2", deployer);
  const factory = await Factory.deploy(ORACLE_ADDRESS);
  await factory.waitForDeployment();

  const factoryAddr = await factory.getAddress();
  console.log("CampaignFactoryV2 deployed to:", factoryAddr);

  // Deploy a test campaign via factory
  // Founder is Account #2, stake = 10% of 1 ETH goal
  const goal      = ethers.parseEther("1");
  const deadline  = Math.floor(Date.now() / 1000) + 86400 * 30;
  const minStake  = goal / 10n;

  const tx = await factory.connect(founder).createCampaign(
    "GreenGrid",
    "Solar drone startup",
    goal,
    deadline,
    "GreenGrid Token",
    "GGT",
    ["Prototype", "Beta", "Launch"],
    [3000, 3000, 4000],
    { value: minStake }
  );

  const receipt = await tx.wait() as any;
  const event = receipt.logs.find((l: any) => {
    try {
      return factory.interface.parseLog(l)?.name === "CampaignCreated";
    } catch { return false; }
  });

  const parsed = factory.interface.parseLog(event) as any;
  const campaignAddr = parsed.args[0];

  console.log("Test campaign deployed to:", campaignAddr);
  console.log("Founder:", await founder.getAddress());

  console.log("\n--- Copy these into your .env ---");
  console.log(`RPC_URL=http://127.0.0.1:8545`);
  console.log(`FACTORY_ADDRESS=${factoryAddr}`);
  console.log(`CAMPAIGN_ADDRESS=${campaignAddr}`);
  console.log(`ORACLE_ADDRESS=${ORACLE_ADDRESS}`);
}

main().catch(console.error);