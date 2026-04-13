import { expect } from "chai";
import hre from "hardhat";

describe("CampaignV2 — Deployment & Invest", function () {
  let ethers: Awaited<ReturnType<typeof hre.network.connect>>["ethers"];

  // Signers
  let founder: any;
  let oracle: any;
  let investor1: any;
  let investor2: any;
  let stranger: any;

  // Addresses
  let founderAddr: string;
  let oracleAddr: string;
  let investor1Addr: string;
  let investor2Addr: string;

  // Campaign params
  const TITLE = "GreenGrid";
  const DESC = "Solar drone startup";

  let goal: bigint;
  let deadline: number;

  const MILESTONE_DESCS = ["Prototype", "Beta", "Launch"];
  const MILESTONE_BPS = [3000, 3000, 4000]; // must sum to 10000

  before(async function () {
    const conn = await hre.network.connect();
    ethers = conn.ethers;
    goal = ethers.parseEther("1");
    deadline = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  });

  beforeEach(async function () {
    [founder, oracle, investor1, investor2, stranger] =
      await ethers.getSigners();

    founderAddr = await founder.getAddress();
    oracleAddr = await oracle.getAddress();
    investor1Addr = await investor1.getAddress();
    investor2Addr = await investor2.getAddress();
  });

  // ── Helper ────────────────────────────────────────────────────

  async function deployCampaign(overrides: any = {}) {
    const Factory = await ethers.getContractFactory("CampaignV2", founder);
    const minStake = goal / 10n; // 10% of goal

    return Factory.deploy(
      overrides.founder ?? founderAddr,
      overrides.oracle ?? oracleAddr,
      overrides.title ?? TITLE,
      overrides.desc ?? DESC,
      overrides.goal ?? goal,
      overrides.deadline ?? deadline,
      overrides.tokenName ?? "GreenGrid Token",
      overrides.tokenSymbol ?? "GGT",
      overrides.descs ?? MILESTONE_DESCS,
      overrides.bps ?? MILESTONE_BPS,
      { value: overrides.stake ?? minStake }
    );
  }

  // ── 1. DEPLOYMENT ─────────────────────────────────────────────

  describe("Deployment", function () {
    it("should deploy with correct founder", async function () {
      const c = await deployCampaign();
      expect(await c.founder()).to.equal(founderAddr);
    });

    it("should deploy with correct oracle", async function () {
      const c = await deployCampaign();
      expect(await c.oracle()).to.equal(oracleAddr);
    });

    it("should deploy with correct goal", async function () {
      const c = await deployCampaign();
      expect(await c.goal()).to.equal(goal);
    });

    it("should deploy with correct title", async function () {
      const c = await deployCampaign();
      expect(await c.title()).to.equal(TITLE);
    });

    it("should store founder stake", async function () {
      const c = await deployCampaign();
      const minStake = goal / 10n;
      expect(await c.founderStake()).to.equal(minStake);
    });

    it("should start in Active state", async function () {
      const c = await deployCampaign();
      // CampaignState.Active = 0
      expect(await c.campaignState()).to.equal(0n);
    });

    it("should deploy a token contract", async function () {
      const c = await deployCampaign();
      const tokenAddr = await c.token();
      expect(tokenAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("should have correct milestone count", async function () {
      const c = await deployCampaign();
      expect(await c.milestoneCount()).to.equal(3n);
    });

    it("should store milestone descriptions correctly", async function () {
      const c = await deployCampaign();
      const m0 = await c.getMilestone(0);
      const m1 = await c.getMilestone(1);
      const m2 = await c.getMilestone(2);
      expect(m0.desc).to.equal("Prototype");
      expect(m1.desc).to.equal("Beta");
      expect(m2.desc).to.equal("Launch");
    });

    it("should store milestone bps correctly", async function () {
      const c = await deployCampaign();
      const m0 = await c.getMilestone(0);
      const m1 = await c.getMilestone(1);
      const m2 = await c.getMilestone(2);
      expect(m0.fundingBps).to.equal(3000n);
      expect(m1.fundingBps).to.equal(3000n);
      expect(m2.fundingBps).to.equal(4000n);
    });

    it("all milestones should start in Pending state", async function () {
      const c = await deployCampaign();
      for (let i = 0; i < 3; i++) {
        const m = await c.getMilestone(i);
        // MilestoneState.Pending = 0
        expect(m.state).to.equal(0n);
      }
    });

    it("should revert if milestone bps dont sum to 10000", async function () {
      let reverted = false;
      try {
        await deployCampaign({ bps: [3000, 3000, 3000] }); // sums to 9000
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if milestone arrays have different lengths", async function () {
      let reverted = false;
      try {
        await deployCampaign({
          descs: ["A", "B"],
          bps: [5000, 3000, 2000],
        });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if no milestones provided", async function () {
      let reverted = false;
      try {
        await deployCampaign({ descs: [], bps: [] });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if stake is below minimum", async function () {
      let reverted = false;
      try {
        const Factory = await ethers.getContractFactory("CampaignV2", founder);
        await Factory.deploy(
          founderAddr,
          oracleAddr,
          TITLE,
          DESC,
          goal,
          deadline,
          "T",
          "T",
          MILESTONE_DESCS,
          MILESTONE_BPS,
          { value: goal / 100n } // only 1%, below 10% minimum
        );
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if goal is 0", async function () {
      let reverted = false;
      try {
        await deployCampaign({ goal: 0n });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if deadline is in the past", async function () {
      let reverted = false;
      try {
        await deployCampaign({ deadline: Math.floor(Date.now() / 1000) - 100 });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if founder address is zero", async function () {
      let reverted = false;
      try {
        await deployCampaign({ founder: ethers.ZeroAddress });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ── 2. INVEST ─────────────────────────────────────────────────

  describe("invest()", function () {
    let campaign: any;
    let tokenContract: any;

    beforeEach(async function () {
      campaign = await deployCampaign();
      const tokenAddr = await campaign.token();
      tokenContract = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
    });

    it("investor receives tokens proportional to investment", async function () {
      // invest 0.1 ETH out of 1 ETH goal = 10% = 1000 tokens
      const investment = ethers.parseEther("0.1");
      await campaign.connect(investor1).invest({ value: investment });

      const TOTAL_SUPPLY = await tokenContract.TOTAL_SUPPLY();
      const expected = (investment * TOTAL_SUPPLY) / goal;

      expect(await tokenContract.balanceOf(investor1Addr)).to.equal(expected);
    });

    it("totalRaised increases by investment amount", async function () {
      const investment = ethers.parseEther("0.2");
      await campaign.connect(investor1).invest({ value: investment });
      expect(await campaign.totalRaised()).to.equal(investment);
    });

    it("investedAmount tracks per-investor correctly", async function () {
      const inv1 = ethers.parseEther("0.3");
      const inv2 = ethers.parseEther("0.5");

      await campaign.connect(investor1).invest({ value: inv1 });
      await campaign.connect(investor2).invest({ value: inv2 });

      expect(await campaign.investedAmount(investor1Addr)).to.equal(inv1);
      expect(await campaign.investedAmount(investor2Addr)).to.equal(inv2);
    });

    it("multiple investments from same address accumulate", async function () {
      const first = ethers.parseEther("0.1");
      const second = ethers.parseEther("0.2");

      await campaign.connect(investor1).invest({ value: first });
      await campaign.connect(investor1).invest({ value: second });

      expect(await campaign.investedAmount(investor1Addr)).to.equal(
        first + second
      );
    });

    it("investor is recorded in investors array", async function () {
      await campaign
        .connect(investor1)
        .invest({ value: ethers.parseEther("0.1") });
      expect(await campaign.investorCount()).to.equal(1n);
      expect(await campaign.investors(0)).to.equal(investor1Addr);
    });

    it("investing twice does not duplicate investor entry", async function () {
      await campaign
        .connect(investor1)
        .invest({ value: ethers.parseEther("0.1") });
      await campaign
        .connect(investor1)
        .invest({ value: ethers.parseEther("0.1") });
      expect(await campaign.investorCount()).to.equal(1n);
    });

    it("emits Invested event with correct args", async function () {
      const investment = ethers.parseEther("0.1");
      const TOTAL_SUPPLY = await tokenContract.TOTAL_SUPPLY();
      const expectedTokens = (investment * TOTAL_SUPPLY) / goal;

      const tx = await campaign
        .connect(investor1)
        .invest({ value: investment });
      const receipt = await tx.wait();

      const event = receipt.logs.find((l: any) => {
        try {
          const parsed = campaign.interface.parseLog(l);
          return parsed?.name === "Invested";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;

      const parsed = campaign.interface.parseLog(event);
      expect(parsed.args[0]).to.equal(investor1Addr);
      expect(parsed.args[1]).to.equal(investment);
      expect(parsed.args[2]).to.equal(expectedTokens);
    });

    it("should revert if investment is 0", async function () {
      let reverted = false;
      try {
        await campaign.connect(investor1).invest({ value: 0 });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if campaign is cancelled", async function () {
      await campaign.connect(founder).cancelCampaign();
      let reverted = false;
      try {
        await campaign
          .connect(investor1)
          .invest({ value: ethers.parseEther("0.1") });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reaching goal transitions state to Funded", async function () {
      await campaign.connect(investor1).invest({ value: goal });
      // CampaignState.Funded = 1
      expect(await campaign.campaignState()).to.equal(1n);
    });

    it("reaching goal emits GoalReached event", async function () {
      const tx = await campaign.connect(investor1).invest({ value: goal });
      const receipt = await tx.wait();

      const event = receipt.logs.find((l: any) => {
        try {
          const parsed = campaign.interface.parseLog(l);
          return parsed?.name === "GoalReached";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("reaching goal sets correct ETH allocations for milestones", async function () {
      await campaign.connect(investor1).invest({ value: goal });

      // milestone 0: 30% of goal
      // milestone 1: 30% of goal
      // milestone 2: 40% of goal
      const m0 = await campaign.getMilestone(0);
      const m1 = await campaign.getMilestone(1);
      const m2 = await campaign.getMilestone(2);

      expect(m0.ethAllocation).to.equal((goal * 3000n) / 10000n);
      expect(m1.ethAllocation).to.equal((goal * 3000n) / 10000n);
      expect(m2.ethAllocation).to.equal((goal * 4000n) / 10000n);
    });

    it("should not accept investments after goal reached", async function () {
      await campaign.connect(investor1).invest({ value: goal });
      // State is now Funded, onlyState(Active) should reject
      let reverted = false;
      try {
        await campaign
          .connect(investor2)
          .invest({ value: ethers.parseEther("0.1") });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ── 3. ORACLE ─────────────────────────────────────────────────

  describe("submitAgentScore()", function () {
    let campaign: any;

    beforeEach(async function () {
      campaign = await deployCampaign();
      // Fund the campaign first
      await campaign.connect(investor1).invest({ value: goal });
    });

    it("oracle can submit score for milestone 0", async function () {
      await campaign.connect(oracle).submitAgentScore(0, 8000);
      const m = await campaign.getMilestone(0);
      expect(m.agentScore).to.equal(8000n);
      expect(m.agentScoreSubmitted).to.equal(true);
    });

    it("emits AgentScoreSubmitted event", async function () {
      const tx = await campaign.connect(oracle).submitAgentScore(0, 7500);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) => {
        try {
          return campaign.interface.parseLog(l)?.name === "AgentScoreSubmitted";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("should revert if non-oracle submits score", async function () {
      let reverted = false;
      try {
        await campaign.connect(stranger).submitAgentScore(0, 8000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if score > 10000", async function () {
      let reverted = false;
      try {
        await campaign.connect(oracle).submitAgentScore(0, 10001);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if milestone index out of bounds", async function () {
      let reverted = false;
      try {
        await campaign.connect(oracle).submitAgentScore(99, 8000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("should revert if score submitted twice", async function () {
      await campaign.connect(oracle).submitAgentScore(0, 8000);
      let reverted = false;
      try {
        await campaign.connect(oracle).submitAgentScore(0, 5000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("founder cannot submit agent score", async function () {
      let reverted = false;
      try {
        await campaign.connect(founder).submitAgentScore(0, 8000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ── 4. CANCEL ─────────────────────────────────────────────────

  describe("cancelCampaign()", function () {
    it("founder can cancel an Active campaign", async function () {
      const c = await deployCampaign();
      await c.connect(founder).cancelCampaign();
      // CampaignState.Cancelled = 3
      expect(await c.campaignState()).to.equal(3n);
    });

    it("emits CampaignCancelled event", async function () {
      const c = await deployCampaign();
      const tx = await c.connect(founder).cancelCampaign();
      const receipt = await tx.wait();
      if (!receipt) throw new Error("transaction receipt is null");
      const event = receipt.logs.find((l: any) => {
        try {
          return c.interface.parseLog(l)?.name === "CampaignCancelled";
        } catch {
          return false;
        }
      });
      expect(event).to.not.be.undefined;
    });

    it("stranger cannot cancel campaign", async function () {
      const c = await deployCampaign();
      let reverted = false;
      try {
        await c.connect(stranger).cancelCampaign();
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("cannot invest after cancellation", async function () {
      const c = await deployCampaign();
      await c.connect(founder).cancelCampaign();
      let reverted = false;
      try {
        await c.connect(investor1).invest({ value: ethers.parseEther("0.1") });
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });
});
