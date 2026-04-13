import { expect } from "chai";
import hre from "hardhat";

describe("CampaignFactoryV2", function () {
let ethers: any;
  let networkHelpers: any;

  let deployer: any;
  let oracle: any;
  let founder1: any;
  let founder2: any;
  let founder3: any;
  let investor: any;
  let stranger: any;

  let deployerAddr: string;
  let oracleAddr: string;
  let founder1Addr: string;
  let founder2Addr: string;
  let founder3Addr: string;
  let investorAddr: string;

  let GOAL: bigint;
  let DEADLINE: number;
  let MIN_STAKE: bigint;

  const MILESTONE_DESCS = ["Prototype", "Launch"];
  const MILESTONE_BPS = [5000, 5000];

  before(async function () {
    const conn = await hre.network.connect();
    ethers = conn.ethers;
    networkHelpers = conn.networkHelpers;
    GOAL = ethers.parseEther("1");
    DEADLINE = Math.floor(Date.now() / 1000) + 86400 * 30;
    MIN_STAKE = GOAL / 10n;
  });

  beforeEach(async function () {
    [deployer, oracle, founder1, founder2, founder3, investor, stranger] =
      await ethers.getSigners();

    deployerAddr = await deployer.getAddress();
    oracleAddr = await oracle.getAddress();
    founder1Addr = await founder1.getAddress();
    founder2Addr = await founder2.getAddress();
    founder3Addr = await founder3.getAddress();
    investorAddr = await investor.getAddress();
  });

  // ── Helpers ────────────────────────────────────────────────────

  async function deployFactory(oracleOverride?: string) {
    const Factory = await ethers.getContractFactory(
      "CampaignFactoryV2",
      deployer
    );
    return Factory.deploy(oracleOverride ?? oracleAddr);
  }

  async function createCampaign(
    factory: any,
    signer: any,
    overrides: Record<string, any> = {}
  ) {
    return factory.connect(signer).createCampaign(
      overrides.title ?? "GreenGrid",
      overrides.description ?? "Solar drone startup",
      overrides.goal ?? GOAL,
      overrides.deadline ?? DEADLINE,
      overrides.tokenName ?? "GreenGrid Token",
      overrides.tokenSymbol ?? "GGT",
      overrides.descs ?? MILESTONE_DESCS,
      overrides.bps ?? MILESTONE_BPS,
      { value: overrides.stake ?? MIN_STAKE }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 1. DEPLOYMENT
  // ─────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("stores oracle address correctly", async function () {
      const factory = await deployFactory();
      expect(await factory.oracle()).to.equal(oracleAddr);
    });

    it("initialises with zero campaigns", async function () {
      const factory = await deployFactory();
      expect(await factory.getCampaignCount()).to.equal(0n);
    });

    it("getCampaigns returns empty array on fresh deploy", async function () {
      const factory = await deployFactory();
      const campaigns = await factory.getCampaigns();
      expect(campaigns.length).to.equal(0);
    });

    it("reverts if oracle is the zero address", async function () {
      let reverted = false;
      try {
        await deployFactory(ethers.ZeroAddress);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("two factories with different oracles are independent", async function () {
      const f1 = await deployFactory(oracleAddr);
      const f2 = await deployFactory(founder2Addr);
      expect(await f1.oracle()).to.equal(oracleAddr);
      expect(await f2.oracle()).to.equal(founder2Addr);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. createCampaign()
  // ─────────────────────────────────────────────────────────────

  describe("createCampaign()", function () {
    let factory: any;

    beforeEach(async function () {
      factory = await deployFactory();
    });

    it("returns a non-zero campaign address", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
      const parsed = factory.interface.parseLog(event);
      expect(parsed.args[0]).to.not.equal(ethers.ZeroAddress);
    });

    it("increments getCampaignCount after creation", async function () {
      await createCampaign(factory, founder1);
      expect(await factory.getCampaignCount()).to.equal(1n);
    });

    it("getCampaignCount is 2 after two campaigns", async function () {
      await createCampaign(factory, founder1);
      await createCampaign(factory, founder2);
      expect(await factory.getCampaignCount()).to.equal(2n);
    });

    it("emits CampaignCreated with correct campaignAddress", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
      const parsed = factory.interface.parseLog(event);
      expect(parsed.args[0]).to.not.equal(ethers.ZeroAddress);
    });

    it("emits CampaignCreated with caller as founder", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const parsed = factory.interface.parseLog(event);
      expect(parsed.args[1]).to.equal(founder1Addr);
    });

    it("emits CampaignCreated with correct title", async function () {
      const tx = await createCampaign(factory, founder1, {
        title: "SolarDrone",
      });
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const parsed = factory.interface.parseLog(event);
      expect(parsed.args[2]).to.equal("SolarDrone");
    });

    it("emits CampaignCreated with correct goal", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const parsed = factory.interface.parseLog(event);
      expect(parsed.args[3]).to.equal(GOAL);
    });

    it("caller (msg.sender) becomes the campaign founder", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const parsed = factory.interface.parseLog(event);
      const campaignAddr = parsed.args[0];
      const campaign = await ethers.getContractAt("CampaignV2", campaignAddr);
      expect(await campaign.founder()).to.equal(founder1Addr);
    });

    it("msg.value is forwarded as founder stake to CampaignV2", async function () {
      const stake = ethers.parseEther("0.2"); // above 10% minimum
      const tx = await createCampaign(factory, founder1, { stake });
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const parsed = factory.interface.parseLog(event);
      const campaignAddr = parsed.args[0];
      const campaign = await ethers.getContractAt("CampaignV2", campaignAddr);
      expect(await campaign.founderStake()).to.equal(stake);
    });

    it("factory does not retain any ETH after createCampaign", async function () {
      await createCampaign(factory, founder1);
      const factoryBalance = await ethers.provider.getBalance(
        await factory.getAddress()
      );
      expect(factoryBalance).to.equal(0n);
    });

    it("two campaigns from different founders have different addresses", async function () {
      const tx1 = await createCampaign(factory, founder1);
      const tx2 = await createCampaign(factory, founder2);

      const r1 = await tx1.wait();
      const r2 = await tx2.wait();

      const getAddr = (receipt: any) => {
        const ev = receipt.logs.find((l: any) => {
          try {
            return factory.interface.parseLog(l)?.name === "CampaignCreated";
          } catch {
            return false;
          }
        });
        return factory.interface.parseLog(ev).args[0];
      };

      expect(getAddr(r1)).to.not.equal(getAddr(r2));
    });

    it("reverts if stake is below the 10% minimum", async function () {
      let reverted = false;
      try {
        await createCampaign(factory, founder1, {
          stake: GOAL / 100n, // 1% — too low
        });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts if milestone bps do not sum to 10000", async function () {
      let reverted = false;
      try {
        await createCampaign(factory, founder1, {
          bps: [3000, 3000], // sums to 6000
        });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts if deadline is in the past", async function () {
      let reverted = false;
      try {
        await createCampaign(factory, founder1, {
          deadline: Math.floor(Date.now() / 1000) - 100,
        });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts if goal is zero", async function () {
      let reverted = false;
      try {
        await createCampaign(factory, founder1, { goal: 0n, stake: 0n });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts if milestone description and bps arrays have different lengths", async function () {
      let reverted = false;
      try {
        await createCampaign(factory, founder1, {
          descs: ["Only one"],
          bps: [5000, 5000],
        });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. CampaignInfo correctness
  // ─────────────────────────────────────────────────────────────

  describe("CampaignInfo correctness", function () {
    let factory: any;
    let campaignAddr: string;
    let createBlock: any;

    beforeEach(async function () {
      factory = await deployFactory();
      const tx = await createCampaign(factory, founder1, {
        title: "InfoTest",
        goal: GOAL,
      });
      const receipt = await tx.wait();
      createBlock = await ethers.provider.getBlock(receipt.blockNumber);
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      campaignAddr = factory.interface.parseLog(event).args[0];
    });

    it("campaignAddress in registry matches returned address", async function () {
      const info = (await factory.getCampaigns())[0];
      expect(info.campaignAddress).to.equal(campaignAddr);
    });

    it("founder in registry equals msg.sender", async function () {
      const info = (await factory.getCampaigns())[0];
      expect(info.founder).to.equal(founder1Addr);
    });

    it("title in registry matches provided title", async function () {
      const info = (await factory.getCampaigns())[0];
      expect(info.title).to.equal("InfoTest");
    });

    it("goal in registry matches provided goal", async function () {
      const info = (await factory.getCampaigns())[0];
      expect(info.goal).to.equal(GOAL);
    });

    it("createdAt equals block.timestamp of deployment tx", async function () {
      const info = (await factory.getCampaigns())[0];
      expect(info.createdAt).to.equal(BigInt(createBlock!.timestamp));
    });

    it("campaigns(0) accessor returns same data as getCampaigns()[0]", async function () {
      const fromArray = (await factory.getCampaigns())[0];
      const fromIndex = await factory.campaigns(0);
      expect(fromIndex.campaignAddress).to.equal(fromArray.campaignAddress);
      expect(fromIndex.founder).to.equal(fromArray.founder);
      expect(fromIndex.goal).to.equal(fromArray.goal);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. Multiple campaigns
  // ─────────────────────────────────────────────────────────────

  describe("Multiple campaigns", function () {
    let factory: any;

    beforeEach(async function () {
      factory = await deployFactory();
    });

    it("getCampaignCount returns 3 after three deployments", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });
      await createCampaign(factory, founder3, { title: "Gamma" });
      expect(await factory.getCampaignCount()).to.equal(3n);
    });

    it("getCampaigns returns all three records in order", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });
      await createCampaign(factory, founder3, { title: "Gamma" });

      const campaigns = await factory.getCampaigns();
      expect(campaigns.length).to.equal(3);
      expect(campaigns[0].title).to.equal("Alpha");
      expect(campaigns[1].title).to.equal("Beta");
      expect(campaigns[2].title).to.equal("Gamma");
    });

    it("each campaign has a unique address", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });
      await createCampaign(factory, founder3, { title: "Gamma" });

      const campaigns = await factory.getCampaigns();
      const addrs = campaigns.map((c: any) => c.campaignAddress);
      const unique = new Set(addrs);
      expect(unique.size).to.equal(3);
    });

    it("each campaign records correct founder", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });

      const campaigns = await factory.getCampaigns();
      expect(campaigns[0].founder).to.equal(founder1Addr);
      expect(campaigns[1].founder).to.equal(founder2Addr);
    });

    it("invest() works on each independently deployed campaign", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });

      const campaigns = await factory.getCampaigns();

      const c1 = await ethers.getContractAt(
        "CampaignV2",
        campaigns[0].campaignAddress
      );
      const c2 = await ethers.getContractAt(
        "CampaignV2",
        campaigns[1].campaignAddress
      );

      await c1
        .connect(investor)
        .invest({ value: ethers.parseEther("0.1") });
      await c2
        .connect(investor)
        .invest({ value: ethers.parseEther("0.2") });

      expect(await c1.totalRaised()).to.equal(ethers.parseEther("0.1"));
      expect(await c2.totalRaised()).to.equal(ethers.parseEther("0.2"));
    });

    it("investing in one campaign does not affect another", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });

      const campaigns = await factory.getCampaigns();
      const c1 = await ethers.getContractAt(
        "CampaignV2",
        campaigns[0].campaignAddress
      );
      const c2 = await ethers.getContractAt(
        "CampaignV2",
        campaigns[1].campaignAddress
      );

      await c1
        .connect(investor)
        .invest({ value: ethers.parseEther("0.5") });

      // c2 should still have zero raised
      expect(await c2.totalRaised()).to.equal(0n);
    });

    it("same founder can create multiple campaigns", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder1, { title: "Beta" });

      const campaigns = await factory.getCampaigns();
      expect(campaigns[0].founder).to.equal(founder1Addr);
      expect(campaigns[1].founder).to.equal(founder1Addr);
      expect(campaigns[0].campaignAddress).to.not.equal(
        campaigns[1].campaignAddress
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. Oracle propagation
  // ─────────────────────────────────────────────────────────────

  describe("Oracle propagation", function () {
    let factory: any;

    beforeEach(async function () {
      factory = await deployFactory();
    });

    it("deployed CampaignV2 oracle matches factory oracle", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const campaignAddr = factory.interface.parseLog(event).args[0];
      const campaign = await ethers.getContractAt("CampaignV2", campaignAddr);
      expect(await campaign.oracle()).to.equal(oracleAddr);
    });

    it("oracle is consistent across all campaigns from same factory", async function () {
      await createCampaign(factory, founder1, { title: "Alpha" });
      await createCampaign(factory, founder2, { title: "Beta" });
      await createCampaign(factory, founder3, { title: "Gamma" });

      const campaigns = await factory.getCampaigns();

      for (const info of campaigns) {
        const campaign = await ethers.getContractAt(
          "CampaignV2",
          info.campaignAddress
        );
        expect(await campaign.oracle()).to.equal(oracleAddr);
      }
    });

    it("oracle on CampaignV2 can submit agent scores", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const campaignAddr = factory.interface.parseLog(event).args[0];
      const campaign = await ethers.getContractAt("CampaignV2", campaignAddr);

      // Fund the campaign first
      await campaign
        .connect(investor)
        .invest({ value: GOAL });

      // Oracle from factory should be able to submit score
      let succeeded = false;
      try {
        await campaign.connect(oracle).submitAgentScore(0, 8000);
        succeeded = true;
      } catch {
        succeeded = false;
      }
      expect(succeeded).to.equal(true);
    });

    it("stranger cannot submit agent score on factory-deployed campaign", async function () {
      const tx = await createCampaign(factory, founder1);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const campaignAddr = factory.interface.parseLog(event).args[0];
      const campaign = await ethers.getContractAt("CampaignV2", campaignAddr);

      await campaign.connect(investor).invest({ value: GOAL });

      let reverted = false;
      try {
        await campaign.connect(stranger).submitAgentScore(0, 8000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. EDGE CASES
  // ─────────────────────────────────────────────────────────────

  describe("Edge Cases", function () {
    let factory: any;

    beforeEach(async function () {
      factory = await deployFactory();
    });

    it("single-milestone campaign (100% bps) deploys correctly", async function () {
      const tx = await createCampaign(factory, founder1, {
        descs: ["Full Delivery"],
        bps: [10000],
      });
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
      const parsed = factory.interface.parseLog(event);
      expect(parsed.args[0]).to.not.equal(ethers.ZeroAddress);
    });

    it("campaign with higher-than-minimum stake deploys correctly", async function () {
      const bigStake = ethers.parseEther("0.5"); // 50% of 1 ETH goal
      const tx = await createCampaign(factory, founder1, {
        stake: bigStake,
      });
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return factory.interface.parseLog(l)?.name === "CampaignCreated";
        } catch {
          return false;
        }
      });
      const parsed = factory.interface.parseLog(event);
      const campaign = await ethers.getContractAt(
        "CampaignV2",
        parsed.args[0]
      );
      expect(await campaign.founderStake()).to.equal(bigStake);
    });

    it("factory oracle is immutable after deployment", async function () {
      // There is no setOracle function — verify the field is truly immutable
      // by confirming it matches what was set and has no setter
      const factory2 = await deployFactory(founder2Addr);
      expect(await factory2.oracle()).to.equal(founder2Addr);
      // Confirm no setter exists by checking the interface
      const hasSetter = factory2.interface.fragments.some(
        (f: any) => f.name === "setOracle"
      );
      expect(hasSetter).to.equal(false);
    });
  });
});