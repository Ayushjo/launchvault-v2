import { expect } from "chai";
import hre from "hardhat";
import { solidityPackedKeccak256 } from "ethers";

describe("CampaignV2 — releaseMilestone() & claimRefund()", function () {
  let ethers: Awaited<ReturnType<typeof hre.network.connect>>["ethers"];
  let networkHelpers: Awaited<
    ReturnType<typeof hre.network.connect>
  >["networkHelpers"];

  let founder: any;
  let oracle: any;
  let investor1: any;
  let investor2: any;
  let stranger: any;

  let founderAddr: string;
  let oracleAddr: string;
  let investor1Addr: string;
  let investor2Addr: string;

  let goal: bigint;

  // ── Mirror contract constants ──────────────────────────────────
  const COMMIT_DURATION  = 4 * 24 * 60 * 60; // 4 days in seconds
  const REVEAL_DURATION  = 3 * 24 * 60 * 60; // 3 days in seconds
  const CHALLENGE_PERIOD = 14 * 24 * 60 * 60; // 14 days in seconds
  const SCALE            = 10_000n;
  const NONVOTER_PENALTY = 500n;
  const TOTAL_SUPPLY     = 10_000n * 10n ** 18n;

  // ── Fixed salts ───────────────────────────────────────────────
  const SALT1  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SALT2  = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const SALT1B = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const SALT2B = "0x2222222222222222222222222222222222222222222222222222222222222222";

  before(async function () {
    const conn     = await hre.network.connect();
    ethers         = conn.ethers;
    networkHelpers = conn.networkHelpers;
    goal           = ethers.parseEther("1");
  });

  beforeEach(async function () {
    [founder, oracle, investor1, investor2, , stranger] =
      await ethers.getSigners();
    founderAddr   = await founder.getAddress();
    oracleAddr    = await oracle.getAddress();
    investor1Addr = await investor1.getAddress();
    investor2Addr = await investor2.getAddress();
  });

  // ══════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════

  function makeHash(probability: number, salt: string): string {
    return solidityPackedKeccak256(
      ["uint256", "bytes32"],
      [probability, salt]
    );
  }

  /** Returns a deadline 30 days ahead of the CURRENT blockchain time. */
  async function freshDeadline(): Promise<number> {
    const t = await networkHelpers.time.latest();
    return t + 60 * 60 * 24 * 30;
  }

  /**
   * Standard 2-milestone (50 / 50) campaign.
   *   investor1 = 0.6 ETH → 6 000 tokens (60 %)
   *   investor2 = 0.4 ETH → 4 000 tokens (40 %)
   *   founderStake = 0.1 ETH (10 % of goal)
   */
  async function deployFundedCampaign() {
    const dl      = await freshDeadline();
    const Factory = await ethers.getContractFactory("CampaignV2", founder);
    const c = await Factory.deploy(
      founderAddr, oracleAddr,
      "GreenGrid", "Solar drone",
      goal, dl,
      "GreenGrid Token", "GGT",
      ["Prototype", "Beta"],
      [5000, 5000],
      { value: goal / 10n }
    );
    await c.connect(investor1).invest({ value: ethers.parseEther("0.6") });
    await c.connect(investor2).invest({ value: ethers.parseEther("0.4") });
    return c;
  }

  /**
   * Quorum-fail campaign.
   *   investor1 = 0.19 ETH → 1 900 tokens (19 %)  — below 20 % quorum
   *   investor2 = 0.81 ETH → 8 100 tokens (81 %)
   */
  async function deployQuorumFailCampaign() {
    const dl      = await freshDeadline();
    const Factory = await ethers.getContractFactory("CampaignV2", founder);
    const c = await Factory.deploy(
      founderAddr, oracleAddr,
      "GreenGrid", "Solar drone",
      goal, dl,
      "GreenGrid Token", "GGT",
      ["Prototype", "Beta"],
      [5000, 5000],
      { value: goal / 10n }
    );
    await c.connect(investor1).invest({ value: ethers.parseEther("0.19") });
    await c.connect(investor2).invest({ value: ethers.parseEther("0.81") });
    return c;
  }

  /**
   * Run a complete commit-reveal cycle for one milestone then advance
   * past the reveal deadline.
   */
  async function runVotingCycle(
    campaign: any,
    milestoneIdx: number,
    agentScore: number,
    voters: Array<{ signer: any; prob: number; salt: string }>,
    commitOnly: Array<{ signer: any; prob: number; salt: string }> = []
  ) {
    await campaign.connect(oracle).submitAgentScore(milestoneIdx, agentScore);
    await campaign.connect(founder).startMilestoneVote();
    for (const v of [...voters, ...commitOnly]) {
      await campaign
        .connect(v.signer)
        .commitVote(milestoneIdx, makeHash(v.prob, v.salt));
    }
    await networkHelpers.mine(COMMIT_DURATION + 1);
    for (const v of voters) {
      await campaign.connect(v.signer).revealVote(milestoneIdx, v.prob, v.salt);
    }
    await networkHelpers.mine(REVEAL_DURATION + 1);
  }

  /**
   * Drive milestone 0 to PASS (avgProb 7 200 ≥ 5 100) with a
   * non-suspicious agent score.
   */
  async function setupPassedMilestone(campaign: any) {
    await runVotingCycle(campaign, 0, 8000, [
      { signer: investor1, prob: 8000, salt: SALT1 },
      { signer: investor2, prob: 6000, salt: SALT2 },
    ]);
    await campaign.connect(stranger).resolveVote(0);
  }

  /**
   * Drive milestone 0 to FAIL (avgProb 2 400 < 5 100) with a
   * non-suspicious agent score (7 000, not > 7 500 or < 2 500).
   * founderStake is slashed; stakeHeldUntil is NOT set.
   *
   * @param inv2votes  When false investor2 does not reveal (becomes non-voter).
   */
  async function setupFailedMilestone(
    campaign: any,
    inv2votes = true
  ) {
    const voters: Array<{ signer: any; prob: number; salt: string }> = [
      { signer: investor1, prob: 2000, salt: SALT1 },
    ];
    if (inv2votes) {
      voters.push({ signer: investor2, prob: 3000, salt: SALT2 });
    }
    await runVotingCycle(campaign, 0, 7000, voters);
    await campaign.connect(stranger).resolveVote(0);
  }

  /**
   * Compute the expected net refund for an investor BEFORE they claim
   * (token balance changes on burn after the claim call).
   *
   *   gross  = (tokenBalance × ethAllocation) / TOTAL_SUPPLY
   *   net    = gross - penaltyDeducted + participationReward + stakeSlashShare
   *            (floored at 0)
   */
  async function computeExpectedNetRefund(
    campaign: any,
    milestoneIdx: number,
    investorAddr: string
  ): Promise<bigint> {
    const tokenAddr = await campaign.token();
    const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
    const balance   = await token.balanceOf(investorAddr);
    const m         = await campaign.getMilestone(milestoneIdx);

    const gross  = (balance * m.ethAllocation) / TOTAL_SUPPLY;
    const penalty = await campaign.penaltyDeducted(milestoneIdx, investorAddr);
    const reward  = await campaign.participationReward(milestoneIdx, investorAddr);
    const slash   = await campaign.stakeSlashShare(milestoneIdx, investorAddr);

    const credit = gross + reward + slash;
    return credit > penalty ? credit - penalty : 0n;
  }

  /**
   * Execute a transaction and return the NET ETH change for the signer,
   * accounting for gas paid.  Positive = received ETH.
   *
   *   change = (balanceAfter - balanceBefore) + gasSpent
   */
  async function netETHChange(
    signer: any,
    txFn: () => Promise<any>
  ): Promise<bigint> {
    const addr   = await signer.getAddress();
    const before = await ethers.provider.getBalance(addr);
    const tx     = await txFn();
    const receipt = await tx.wait();
    if (!receipt) throw new Error("null receipt");
    const gasSpent = receipt.gasUsed * receipt.gasPrice;
    const after  = await ethers.provider.getBalance(addr);
    return after - before + gasSpent;
  }

  // ══════════════════════════════════════════════════════════════
  // releaseMilestone()
  // ══════════════════════════════════════════════════════════════

  describe("releaseMilestone()", function () {
    // ── 1. Access & state guards ─────────────────────────────────

    describe("access & state guards", function () {
      it("reverts if caller is not the founder", async function () {
        const c = await deployFundedCampaign();
        await setupPassedMilestone(c);
        let reverted = false;
        try {
          await c.connect(stranger).releaseMilestone(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts if milestone is in Pending state (not yet voted)", async function () {
        const c = await deployFundedCampaign();
        let reverted = false;
        try {
          await c.connect(founder).releaseMilestone(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts if milestone is in Failed state", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);
        let reverted = false;
        try {
          await c.connect(founder).releaseMilestone(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts if milestone is Inconclusive (quorum not met)", async function () {
        const c = await deployQuorumFailCampaign();
        await runVotingCycle(c, 0, 7000, [
          { signer: investor1, prob: 8000, salt: SALT1 },
        ]);
        await c.connect(stranger).resolveVote(0);
        let reverted = false;
        try {
          await c.connect(founder).releaseMilestone(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts with an invalid milestone index", async function () {
        const c = await deployFundedCampaign();
        let reverted = false;
        try {
          await c.connect(founder).releaseMilestone(99);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts on a second call (funds already released)", async function () {
        const c = await deployFundedCampaign();
        await setupPassedMilestone(c);
        await c.connect(founder).releaseMilestone(0);
        let reverted = false;
        try {
          await c.connect(founder).releaseMilestone(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });
    });

    // ── 2. Basic release ─────────────────────────────────────────

    describe("basic release", function () {
      let campaign: any;

      beforeEach(async function () {
        campaign = await deployFundedCampaign();
        await setupPassedMilestone(campaign);
      });

      it("sets fundsReleased to true on the milestone", async function () {
        await campaign.connect(founder).releaseMilestone(0);
        const m = await campaign.getMilestone(0);
        expect(m.fundsReleased).to.equal(true);
      });

      it("transfers the correct ethAllocation to the founder", async function () {
        // 50 % of 1 ETH goal = 0.5 ETH
        const expected = ethers.parseEther("0.5");
        const delta = await netETHChange(founder, () =>
          campaign.connect(founder).releaseMilestone(0)
        );
        expect(delta).to.equal(expected);
      });

      it("emits MilestonePassed with milestoneIndex and ethAllocation", async function () {
        const tx      = await campaign.connect(founder).releaseMilestone(0);
        const receipt = await tx.wait();
        if (!receipt) throw new Error("null receipt");
        const log = receipt.logs.find((l: any) => {
          try {
            return campaign.interface.parseLog(l)?.name === "MilestonePassed";
          } catch {
            return false;
          }
        });
        expect(log).to.not.be.undefined;
        const parsed = campaign.interface.parseLog(log);
        expect(parsed.args[0]).to.equal(0n);
        expect(parsed.args[1]).to.equal(ethers.parseEther("0.5"));
      });

      it("does NOT return founderStake when the second milestone is unreleased", async function () {
        const stakeBefore = await campaign.founderStake();
        await campaign.connect(founder).releaseMilestone(0);
        expect(await campaign.founderStake()).to.equal(stakeBefore);
      });

      it("does NOT emit FounderStakeReturned when second milestone is unreleased", async function () {
        const tx      = await campaign.connect(founder).releaseMilestone(0);
        const receipt = await tx.wait();
        if (!receipt) throw new Error("null receipt");
        const log = receipt.logs.find((l: any) => {
          try {
            return (
              campaign.interface.parseLog(l)?.name === "FounderStakeReturned"
            );
          } catch {
            return false;
          }
        });
        expect(log).to.be.undefined;
      });
    });

    // ── 3. Stake returned on full completion ─────────────────────

    describe("founder stake returned after all milestones released", function () {
      let campaign: any;
      let initialStake: bigint;

      beforeEach(async function () {
        campaign     = await deployFundedCampaign();
        initialStake = await campaign.founderStake(); // 0.1 ETH

        // Pass and release milestone 0
        await setupPassedMilestone(campaign);
        await campaign.connect(founder).releaseMilestone(0);

        // Pass milestone 1
        await runVotingCycle(campaign, 1, 8000, [
          { signer: investor1, prob: 8000, salt: SALT1B },
          { signer: investor2, prob: 6000, salt: SALT2B },
        ]);
        await campaign.connect(stranger).resolveVote(1);
        // campaignState is now Completed
        expect(await campaign.campaignState()).to.equal(2n);
      });

      it("founderStake is set to 0 after the last milestone is released", async function () {
        await campaign.connect(founder).releaseMilestone(1);
        expect(await campaign.founderStake()).to.equal(0n);
      });

      it("founder receives ethAllocation + stake on the last release", async function () {
        // 0.5 ETH (ethAllocation for milestone 1) + 0.1 ETH (stake)
        const expected = ethers.parseEther("0.5") + initialStake;
        const delta = await netETHChange(founder, () =>
          campaign.connect(founder).releaseMilestone(1)
        );
        expect(delta).to.equal(expected);
      });

      it("emits FounderStakeReturned with the correct stake amount", async function () {
        const tx      = await campaign.connect(founder).releaseMilestone(1);
        const receipt = await tx.wait();
        if (!receipt) throw new Error("null receipt");
        const log = receipt.logs.find((l: any) => {
          try {
            return (
              campaign.interface.parseLog(l)?.name === "FounderStakeReturned"
            );
          } catch {
            return false;
          }
        });
        expect(log).to.not.be.undefined;
        const parsed = campaign.interface.parseLog(log);
        expect(parsed.args[0]).to.equal(initialStake);
      });

      it("emits MilestonePassed for the released milestone as well", async function () {
        const tx      = await campaign.connect(founder).releaseMilestone(1);
        const receipt = await tx.wait();
        if (!receipt) throw new Error("null receipt");
        const log = receipt.logs.find((l: any) => {
          try {
            return campaign.interface.parseLog(l)?.name === "MilestonePassed";
          } catch {
            return false;
          }
        });
        expect(log).to.not.be.undefined;
      });

      it("milestones can be released in reverse order (1 then 0)", async function () {
        // Re-deploy a fresh completed campaign for this test
        const c      = await deployFundedCampaign();
        const stake  = await c.founderStake();

        await setupPassedMilestone(c);
        await runVotingCycle(c, 1, 8000, [
          { signer: investor1, prob: 8000, salt: SALT1B },
          { signer: investor2, prob: 6000, salt: SALT2B },
        ]);
        await c.connect(stranger).resolveVote(1);

        // Release 1 first — stake should NOT come back yet
        await c.connect(founder).releaseMilestone(1);
        expect(await c.founderStake()).to.equal(stake);

        // Release 0 — all done, stake returned
        const delta = await netETHChange(founder, () =>
          c.connect(founder).releaseMilestone(0)
        );
        expect(delta).to.equal(ethers.parseEther("0.5") + stake);
        expect(await c.founderStake()).to.equal(0n);
      });
    });

    // ── 4. Suspicious collusion hold ─────────────────────────────

    describe("challenge period (stakeHeldUntil)", function () {
      let campaign: any;

      beforeEach(async function () {
        campaign = await deployFundedCampaign();
        // agentScore = 1 000 (< 2 500, very confident NO)
        // vote = PASS  (avgProb 7 200 ≥ 5 100) → suspicious
        await runVotingCycle(campaign, 0, 1000, [
          { signer: investor1, prob: 8000, salt: SALT1 },
          { signer: investor2, prob: 6000, salt: SALT2 },
        ]);
        await campaign.connect(stranger).resolveVote(0);
        // milestone is Passed; stakeHeldUntil[0] is set
      });

      it("reverts if called before the 14-day challenge period elapses", async function () {
        let reverted = false;
        try {
          await campaign.connect(founder).releaseMilestone(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("succeeds after the 14-day challenge period elapses", async function () {
        await networkHelpers.mine(CHALLENGE_PERIOD + 1);
        await campaign.connect(founder).releaseMilestone(0);
        const m = await campaign.getMilestone(0);
        expect(m.fundsReleased).to.equal(true);
      });

      it("transfers correct ETH to founder after hold expires", async function () {
        await networkHelpers.mine(CHALLENGE_PERIOD + 1);
        const delta = await netETHChange(founder, () =>
          campaign.connect(founder).releaseMilestone(0)
        );
        expect(delta).to.equal(ethers.parseEther("0.5"));
      });

      it("stakeHeldUntil is set to resolveBlock + 14 days", async function () {
        const held = await campaign.stakeHeldUntil(0);
        // held > 0 and is in the future
        expect(held).to.be.gt(0n);
        const latest = BigInt(await networkHelpers.time.latest());
        expect(held).to.be.gt(latest);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════
  // claimRefund()
  // ══════════════════════════════════════════════════════════════

  describe("claimRefund()", function () {
    // ── 1. Access & state guards ─────────────────────────────────

    describe("access & state guards", function () {
      it("reverts if milestone is Passed (not refundable)", async function () {
        const c = await deployFundedCampaign();
        await setupPassedMilestone(c);
        let reverted = false;
        try {
          await c.connect(investor1).claimRefund(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts if milestone is Pending", async function () {
        const c = await deployFundedCampaign();
        let reverted = false;
        try {
          await c.connect(investor1).claimRefund(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts with an invalid milestone index", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);
        let reverted = false;
        try {
          await c.connect(investor1).claimRefund(99);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts if caller holds no tokens", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);
        let reverted = false;
        try {
          await c.connect(stranger).claimRefund(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });

      it("reverts on a second claim (double-claim prevented)", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);
        await c.connect(investor1).claimRefund(0);
        let reverted = false;
        try {
          await c.connect(investor1).claimRefund(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(true);
      });
    });

    // ── 2. Correct ETH amounts (both investors voted) ─────────────
    //
    // Scenario: both investors vote, milestone FAILS (non-suspicious).
    // founderStake is slashed; no penalty pool (everyone voted).
    //
    //   investor1: gross = 60 % × 0.5 ETH = 0.3 ETH
    //              slash = 60 % × 0.1 ETH = 0.06 ETH
    //              net   = 0.36 ETH
    //
    //   investor2: gross = 40 % × 0.5 ETH = 0.2 ETH
    //              slash = 40 % × 0.1 ETH = 0.04 ETH
    //              net   = 0.24 ETH

    describe("correct ETH amounts — both voted, non-suspicious fail", function () {
      let campaign: any;

      beforeEach(async function () {
        campaign = await deployFundedCampaign();
        await setupFailedMilestone(campaign);
      });

      it("investor1 receives the exact expected net refund", async function () {
        const expected = await computeExpectedNetRefund(campaign, 0, investor1Addr);
        const delta    = await netETHChange(investor1, () =>
          campaign.connect(investor1).claimRefund(0)
        );
        expect(delta).to.equal(expected);
        expect(expected).to.equal(ethers.parseEther("0.36"));
      });

      it("investor2 receives the exact expected net refund", async function () {
        const expected = await computeExpectedNetRefund(campaign, 0, investor2Addr);
        const delta    = await netETHChange(investor2, () =>
          campaign.connect(investor2).claimRefund(0)
        );
        expect(delta).to.equal(expected);
        expect(expected).to.equal(ethers.parseEther("0.24"));
      });

      it("grossRefund is exactly (tokenBalance × ethAllocation) / TOTAL_SUPPLY", async function () {
        const tokenAddr = await campaign.token();
        const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        const balance   = await token.balanceOf(investor1Addr);
        const m         = await campaign.getMilestone(0);
        const gross     = (balance * m.ethAllocation) / TOTAL_SUPPLY;
        // 6 000 × 0.5 ETH / 10 000 = 0.3 ETH
        expect(gross).to.equal(ethers.parseEther("0.3"));
      });

      it("sets refundClaimed to true after a successful claim", async function () {
        expect(await campaign.refundClaimed(0, investor1Addr)).to.equal(false);
        await campaign.connect(investor1).claimRefund(0);
        expect(await campaign.refundClaimed(0, investor1Addr)).to.equal(true);
      });

      it("emits RefundClaimed with caller, milestoneIndex, and netRefund", async function () {
        const expected = await computeExpectedNetRefund(campaign, 0, investor1Addr);
        const tx       = await campaign.connect(investor1).claimRefund(0);
        const receipt  = await tx.wait();
        if (!receipt) throw new Error("null receipt");
        const log = receipt.logs.find((l: any) => {
          try {
            return campaign.interface.parseLog(l)?.name === "RefundClaimed";
          } catch {
            return false;
          }
        });
        expect(log).to.not.be.undefined;
        const parsed = campaign.interface.parseLog(log);
        expect(parsed.args[0]).to.equal(investor1Addr);
        expect(parsed.args[1]).to.equal(0n);
        expect(parsed.args[2]).to.equal(expected);
      });

      it("investor1 and investor2 can both claim independently", async function () {
        const exp1 = await computeExpectedNetRefund(campaign, 0, investor1Addr);
        const exp2 = await computeExpectedNetRefund(campaign, 0, investor2Addr);

        const delta1 = await netETHChange(investor1, () =>
          campaign.connect(investor1).claimRefund(0)
        );
        const delta2 = await netETHChange(investor2, () =>
          campaign.connect(investor2).claimRefund(0)
        );

        expect(delta1).to.equal(exp1);
        expect(delta2).to.equal(exp2);
      });

      it("contract balance decreases by exactly netRefund after each claim", async function () {
        const contractAddr = await campaign.getAddress();
        const net1  = await computeExpectedNetRefund(campaign, 0, investor1Addr);
        const balBefore = await ethers.provider.getBalance(contractAddr);
        await campaign.connect(investor1).claimRefund(0);
        const balAfter  = await ethers.provider.getBalance(contractAddr);
        expect(balBefore - balAfter).to.equal(net1);
      });
    });

    // ── 3. Penalty deduction for non-voters ───────────────────────
    //
    // investor1 votes 2000 (FAIL outcome); investor2 does NOT vote.
    //
    //   investor2 penalty = 0.4 ETH × 5 % = 0.02 ETH
    //   investor2 net     = 0.2 - 0.02 + 0 + 0.04 = 0.22 ETH

    describe("penalty deduction for non-voters", function () {
      let campaign: any;

      beforeEach(async function () {
        campaign = await deployFundedCampaign();
        // Only investor1 reveals — investor2 is the non-voter
        await runVotingCycle(campaign, 0, 7000, [
          { signer: investor1, prob: 2000, salt: SALT1 },
        ]);
        await campaign.connect(stranger).resolveVote(0);
      });

      it("penaltyDeducted for investor2 equals 5 % of their investedAmount", async function () {
        const expected = (ethers.parseEther("0.4") * NONVOTER_PENALTY) / SCALE;
        expect(await campaign.penaltyDeducted(0, investor2Addr)).to.equal(expected);
      });

      it("penaltyDeducted for investor1 (the voter) is zero", async function () {
        expect(await campaign.penaltyDeducted(0, investor1Addr)).to.equal(0n);
      });

      it("investor2 refund is reduced by the penalty amount", async function () {
        // net = 0.2 - 0.02 + 0 + 0.04 = 0.22 ETH
        const expected = await computeExpectedNetRefund(campaign, 0, investor2Addr);
        const delta    = await netETHChange(investor2, () =>
          campaign.connect(investor2).claimRefund(0)
        );
        expect(delta).to.equal(expected);
        expect(expected).to.equal(ethers.parseEther("0.22"));
      });
    });

    // ── 4. Participation reward for voters ────────────────────────
    //
    // investor1 votes 2000 (accurate for FAIL), investor2 does NOT vote.
    // Penalty pool = 0.02 ETH (investor2's penalty).
    // investor1 is the only voter → receives the full pool as reward.
    //
    //   investor1 net = 0.3 + 0.02 + 0.06 = 0.38 ETH

    describe("participation reward added to voter refund", function () {
      let campaign: any;

      beforeEach(async function () {
        campaign = await deployFundedCampaign();
        await runVotingCycle(campaign, 0, 7000, [
          { signer: investor1, prob: 2000, salt: SALT1 },
        ]);
        await campaign.connect(stranger).resolveVote(0);
      });

      it("investor1 participationReward equals the full penalty pool", async function () {
        const pool = (ethers.parseEther("0.4") * NONVOTER_PENALTY) / SCALE;
        expect(await campaign.participationReward(0, investor1Addr)).to.equal(pool);
      });

      it("investor2 (non-voter) has zero participationReward", async function () {
        expect(await campaign.participationReward(0, investor2Addr)).to.equal(0n);
      });

      it("investor1 netRefund includes both reward and slash", async function () {
        const expected = await computeExpectedNetRefund(campaign, 0, investor1Addr);
        const delta    = await netETHChange(investor1, () =>
          campaign.connect(investor1).claimRefund(0)
        );
        expect(delta).to.equal(expected);
        expect(expected).to.equal(ethers.parseEther("0.38"));
      });
    });

    // ── 5. Stake slash share ──────────────────────────────────────

    describe("stake slash share added to refund", function () {
      it("stakeSlashShare for investor1 is 60 % of founderStake", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);
        expect(await c.stakeSlashShare(0, investor1Addr)).to.equal(
          ethers.parseEther("0.06")
        );
      });

      it("stakeSlashShare for investor2 is 40 % of founderStake", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);
        expect(await c.stakeSlashShare(0, investor2Addr)).to.equal(
          ethers.parseEther("0.04")
        );
      });

      it("total slash shares sum to the original founderStake", async function () {
        const c = await deployFundedCampaign();
        const stake = await c.founderStake();
        await setupFailedMilestone(c);
        const s1 = await c.stakeSlashShare(0, investor1Addr);
        const s2 = await c.stakeSlashShare(0, investor2Addr);
        expect(s1 + s2).to.equal(stake);
      });

      it("stakeSlashShare is 0 when milestone is suspicious (stake not slashed)", async function () {
        const c = await deployFundedCampaign();
        // agentScore = 9 000 > 7 500 + FAIL → suspicious → stake held
        await runVotingCycle(c, 0, 9000, [
          { signer: investor1, prob: 2000, salt: SALT1 },
          { signer: investor2, prob: 3000, salt: SALT2 },
        ]);
        await c.connect(stranger).resolveVote(0);
        expect(await c.stakeSlashShare(0, investor1Addr)).to.equal(0n);
        expect(await c.stakeSlashShare(0, investor2Addr)).to.equal(0n);
      });

      it("suspicious fail refund = pure grossRefund (both voted, no slash, no penalty)", async function () {
        const c = await deployFundedCampaign();
        await runVotingCycle(c, 0, 9000, [
          { signer: investor1, prob: 2000, salt: SALT1 },
          { signer: investor2, prob: 3000, salt: SALT2 },
        ]);
        await c.connect(stranger).resolveVote(0);

        // gross = 60 % × 0.5 ETH = 0.3 ETH; nothing else
        const expected = await computeExpectedNetRefund(c, 0, investor1Addr);
        expect(expected).to.equal(ethers.parseEther("0.3"));

        const delta = await netETHChange(investor1, () =>
          c.connect(investor1).claimRefund(0)
        );
        expect(delta).to.equal(expected);
      });
    });

    // ── 6. Inconclusive milestones ────────────────────────────────

    describe("Inconclusive milestone refunds", function () {
      let campaign: any;

      beforeEach(async function () {
        // Only investor1 (19 %) reveals → quorum fails → Inconclusive
        campaign = await deployQuorumFailCampaign();
        await runVotingCycle(campaign, 0, 7000, [
          { signer: investor1, prob: 8000, salt: SALT1 },
        ]);
        await campaign.connect(stranger).resolveVote(0);
      });

      it("investor can claim a refund on an Inconclusive milestone", async function () {
        let reverted = false;
        try {
          await campaign.connect(investor1).claimRefund(0);
        } catch {
          reverted = true;
        }
        expect(reverted).to.equal(false);
      });

      it("Inconclusive refund equals pure grossRefund (no penalty/reward/slash set)", async function () {
        // resolveVote returned early — none of the accounting mappings were set
        expect(await campaign.penaltyDeducted(0, investor1Addr)).to.equal(0n);
        expect(await campaign.participationReward(0, investor1Addr)).to.equal(0n);
        expect(await campaign.stakeSlashShare(0, investor1Addr)).to.equal(0n);

        const tokenAddr = await campaign.token();
        const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        const balance   = await token.balanceOf(investor1Addr);
        const m         = await campaign.getMilestone(0);
        const gross     = (balance * m.ethAllocation) / TOTAL_SUPPLY;

        const delta = await netETHChange(investor1, () =>
          campaign.connect(investor1).claimRefund(0)
        );
        expect(delta).to.equal(gross);
      });

      it("investor2 can also claim their proportional Inconclusive refund", async function () {
        const tokenAddr = await campaign.token();
        const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        const balance2  = await token.balanceOf(investor2Addr);
        const m         = await campaign.getMilestone(0);
        const gross2    = (balance2 * m.ethAllocation) / TOTAL_SUPPLY;

        const delta = await netETHChange(investor2, () =>
          campaign.connect(investor2).claimRefund(0)
        );
        expect(delta).to.equal(gross2);
      });
    });

    // ── 7. Token burn behavior ────────────────────────────────────

    describe("token burn behavior", function () {
      it("tokens are NOT burned when the second milestone is still Pending", async function () {
        // Milestone 0 fails → milestone 1 stays Pending
        // _allMilestonesTerminal() = false → no burn
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);

        const tokenAddr     = await c.token();
        const token         = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        const balanceBefore = await token.balanceOf(investor1Addr);

        await c.connect(investor1).claimRefund(0);

        expect(await token.balanceOf(investor1Addr)).to.equal(balanceBefore);
      });

      it("tokens ARE burned when all milestones are terminal (milestone 0 passes, milestone 1 fails)", async function () {
        // milestone 0 = Passed, milestone 1 = Failed → both terminal
        // Claiming milestone 1 refund triggers the burn
        const c = await deployFundedCampaign();
        await setupPassedMilestone(c);

        await runVotingCycle(c, 1, 7000, [
          { signer: investor1, prob: 2000, salt: SALT1B },
          { signer: investor2, prob: 3000, salt: SALT2B },
        ]);
        await c.connect(stranger).resolveVote(1);

        const tokenAddr = await c.token();
        const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        expect(await token.balanceOf(investor1Addr)).to.be.gt(0n);

        await c.connect(investor1).claimRefund(1);

        expect(await token.balanceOf(investor1Addr)).to.equal(0n);
      });

      it("investor2 tokens also burned when all milestones terminal", async function () {
        const c = await deployFundedCampaign();
        await setupPassedMilestone(c);

        await runVotingCycle(c, 1, 7000, [
          { signer: investor1, prob: 2000, salt: SALT1B },
          { signer: investor2, prob: 3000, salt: SALT2B },
        ]);
        await c.connect(stranger).resolveVote(1);

        await c.connect(investor1).claimRefund(1);
        await c.connect(investor2).claimRefund(1);

        const tokenAddr = await c.token();
        const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        expect(await token.balanceOf(investor2Addr)).to.equal(0n);
      });

      it("token burn reduces totalSupply correctly", async function () {
        const c = await deployFundedCampaign();
        await setupPassedMilestone(c);

        await runVotingCycle(c, 1, 7000, [
          { signer: investor1, prob: 2000, salt: SALT1B },
          { signer: investor2, prob: 3000, salt: SALT2B },
        ]);
        await c.connect(stranger).resolveVote(1);

        const tokenAddr = await c.token();
        const token     = await ethers.getContractAt("CampaignTokenV2", tokenAddr);
        const supply0   = await token.totalSupply();

        const balance1 = await token.balanceOf(investor1Addr);
        await c.connect(investor1).claimRefund(1);

        expect(await token.totalSupply()).to.equal(supply0 - balance1);
      });
    });

    // ── 8. Net refund floored at zero ─────────────────────────────

    describe("netRefund is floored at 0 when penalty > credit", function () {
      it("returns 0 ETH (not a negative or revert) when penalty > gross + slash", async function () {
        // Tiny milestone (1 bps) makes grossRefund << penalty.
        // Suspicious failure means stakeSlashShare = 0.
        // investor2 (non-voter): gross=0.004 ETH < penalty=0.02 ETH → floor to 0.
        const dl      = await freshDeadline();
        const Factory = await ethers.getContractFactory("CampaignV2", founder);
        const c = await Factory.deploy(
          founderAddr, oracleAddr, "T", "D", goal, dl,
          "T", "T", ["tiny", "big"], [100, 9900],
          { value: goal / 10n }
        );
        await c.connect(investor1).invest({ value: ethers.parseEther("0.6") });
        await c.connect(investor2).invest({ value: ethers.parseEther("0.4") });

        // Suspicious failure: agentScore=9000, vote=FAIL → stakeSlashShare=0
        // investor2 does NOT vote → penaltyDeducted[0][inv2] = 0.4×500/10000 = 0.02 ETH
        // investor2 grossRefund   = 40%×0.01 ETH = 0.004 ETH
        // credit = 0.004 + 0 + 0 = 0.004 < 0.02 → net = 0
        await runVotingCycle(c, 0, 9000, [
          { signer: investor1, prob: 2000, salt: SALT1 },
        ]);
        await c.connect(stranger).resolveVote(0);

        const expected = await computeExpectedNetRefund(c, 0, investor2Addr);
        expect(expected).to.equal(0n); // confirmed floor triggers

        // Must not revert; investor2 gets 0 ETH but claim succeeds
        const delta = await netETHChange(investor2, () =>
          c.connect(investor2).claimRefund(0)
        );
        expect(delta).to.equal(0n);
      });

      it("refundClaimed is set to true even when netRefund is 0", async function () {
        const dl      = await freshDeadline();
        const Factory = await ethers.getContractFactory("CampaignV2", founder);
        const c = await Factory.deploy(
          founderAddr, oracleAddr, "T", "D", goal, dl,
          "T", "T", ["tiny", "big"], [100, 9900],
          { value: goal / 10n }
        );
        await c.connect(investor1).invest({ value: ethers.parseEther("0.6") });
        await c.connect(investor2).invest({ value: ethers.parseEther("0.4") });

        await runVotingCycle(c, 0, 9000, [
          { signer: investor1, prob: 2000, salt: SALT1 },
        ]);
        await c.connect(stranger).resolveVote(0);

        await c.connect(investor2).claimRefund(0);
        expect(await c.refundClaimed(0, investor2Addr)).to.equal(true);
      });
    });

    // ── 9. Full accounting invariant ─────────────────────────────

    describe("full ETH accounting invariant", function () {
      it("contract holds enough ETH for both investor refunds after a fail", async function () {
        const c = await deployFundedCampaign();
        await setupFailedMilestone(c);

        const contractAddr = await c.getAddress();
        const contractBal  = await ethers.provider.getBalance(contractAddr);

        const net1 = await computeExpectedNetRefund(c, 0, investor1Addr);
        const net2 = await computeExpectedNetRefund(c, 0, investor2Addr);

        expect(contractBal).to.be.gte(net1 + net2);
      });

      it("combined netRefunds equal ethAllocation + founderStake (both voted, fully slashed)", async function () {
        const c = await deployFundedCampaign();
        const stake = await c.founderStake();
        const m     = await c.getMilestone(0);
        await setupFailedMilestone(c);

        const net1 = await computeExpectedNetRefund(c, 0, investor1Addr);
        const net2 = await computeExpectedNetRefund(c, 0, investor2Addr);

        // All ETH from this milestone's allocation + the full stake is paid out
        expect(net1 + net2).to.equal(m.ethAllocation + stake);
      });
    });
  });
});
