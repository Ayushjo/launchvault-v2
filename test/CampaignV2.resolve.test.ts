import { expect } from "chai";
import hre from "hardhat";
import { solidityPackedKeccak256 } from "ethers";

describe("CampaignV2 — resolveVote()", function () {
  let ethers: Awaited<ReturnType<typeof hre.network.connect>>["ethers"];
  let networkHelpers: Awaited<
    ReturnType<typeof hre.network.connect>
  >["networkHelpers"];

  let founder: any;
  let oracle: any;
  let investor1: any;
  let investor2: any;
  let investor3: any;
  let stranger: any;

  let founderAddr: string;
  let oracleAddr: string;
  let investor1Addr: string;
  let investor2Addr: string;
  let investor3Addr: string;

  let goal: bigint;

  // Mirror contract constants
  const COMMIT_DURATION  = 4 * 24 * 60 * 60; // seconds
  const REVEAL_DURATION  = 3 * 24 * 60 * 60;
  const SCALE            = 10_000n;
  const NONVOTER_PENALTY = 500n;
  const CHALLENGE_PERIOD = BigInt(14 * 24 * 60 * 60);

  // Fixed salts — reproducible hashes, unique per milestone
  const SALT1  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SALT2  = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const SALT3  = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const SALT1B = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const SALT2B = "0x2222222222222222222222222222222222222222222222222222222222222222";

  before(async function () {
    const conn = await hre.network.connect();
    ethers         = conn.ethers;
    networkHelpers = conn.networkHelpers;
    goal           = ethers.parseEther("1");
  });

  beforeEach(async function () {
    [founder, oracle, investor1, investor2, investor3, stranger] =
      await ethers.getSigners();

    founderAddr   = await founder.getAddress();
    oracleAddr    = await oracle.getAddress();
    investor1Addr = await investor1.getAddress();
    investor2Addr = await investor2.getAddress();
    investor3Addr = await investor3.getAddress();
  });

  // ── Helpers ───────────────────────────────────────────────────

  function makeHash(probability: number, salt: string): string {
    return solidityPackedKeccak256(
      ["uint256", "bytes32"],
      [probability, salt]
    );
  }

  /** Fresh deadline always 30 days ahead of current blockchain time. */
  async function freshDeadline(): Promise<number> {
    const latest = await networkHelpers.time.latest();
    return latest + 60 * 60 * 24 * 30;
  }

  /**
   * Standard 2-milestone (50 / 50) campaign.
   *   investor1 = 0.6 ETH → 6 000 tokens (60 %)
   *   investor2 = 0.4 ETH → 4 000 tokens (40 %)
   */
  async function deployFundedCampaign() {
    const dl      = await freshDeadline();
    const Factory = await ethers.getContractFactory("CampaignV2", founder);
    const campaign = await Factory.deploy(
      founderAddr, oracleAddr,
      "GreenGrid", "Solar drone",
      goal, dl,
      "GreenGrid Token", "GGT",
      ["Prototype", "Beta"],
      [5000, 5000],
      { value: goal / 10n }
    );
    await campaign.connect(investor1).invest({ value: ethers.parseEther("0.6") });
    await campaign.connect(investor2).invest({ value: ethers.parseEther("0.4") });
    return campaign;
  }

  /**
   * Quorum-fail campaign.
   *   investor1 = 0.19 ETH → 1 900 tokens (19 %)
   *   investor2 = 0.81 ETH → 8 100 tokens (81 %)
   * Voting only investor1 gives 19 % participation < 20 % quorum.
   */
  async function deployQuorumFailCampaign() {
    const dl      = await freshDeadline();
    const Factory = await ethers.getContractFactory("CampaignV2", founder);
    const campaign = await Factory.deploy(
      founderAddr, oracleAddr,
      "GreenGrid", "Solar drone",
      goal, dl,
      "GreenGrid Token", "GGT",
      ["Prototype", "Beta"],
      [5000, 5000],
      { value: goal / 10n }
    );
    await campaign.connect(investor1).invest({ value: ethers.parseEther("0.19") });
    await campaign.connect(investor2).invest({ value: ethers.parseEther("0.81") });
    return campaign;
  }

  /**
   * Run a full voting cycle for one milestone.
   *
   * @param campaign       Funded campaign contract
   * @param milestoneIdx   Which milestone (must equal currentMilestoneIndex)
   * @param agentScore     Oracle score to submit (0–10 000)
   * @param voters         Investors who commit AND reveal
   * @param commitOnly     Investors who commit but do NOT reveal
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

  // ── 1. ACCESS & TIMING GUARDS ─────────────────────────────────

  describe("access & timing guards", function () {
    it("reverts if reveal deadline has not passed yet", async function () {
      const c = await deployFundedCampaign();
      await c.connect(oracle).submitAgentScore(0, 8000);
      await c.connect(founder).startMilestoneVote();
      await c.connect(investor1).commitVote(0, makeHash(8000, SALT1));
      await c.connect(investor2).commitVote(0, makeHash(6000, SALT2));
      await networkHelpers.mine(COMMIT_DURATION + 1);
      await c.connect(investor1).revealVote(0, 8000, SALT1);
      await c.connect(investor2).revealVote(0, 6000, SALT2);
      // Still inside reveal window — do NOT mine past it
      let reverted = false;
      try {
        await c.connect(stranger).resolveVote(0);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts when milestone is still in Pending state", async function () {
      const c = await deployFundedCampaign();
      let reverted = false;
      try {
        await c.connect(stranger).resolveVote(0);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts when milestone is VotingOpen (no reveals yet)", async function () {
      const c = await deployFundedCampaign();
      await c.connect(oracle).submitAgentScore(0, 8000);
      await c.connect(founder).startMilestoneVote();
      // Nobody has revealed — state is VotingOpen, not RevealOpen
      let reverted = false;
      try {
        await c.connect(stranger).resolveVote(0);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("reverts if milestoneIndex does not equal currentMilestoneIndex", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      // currentMilestoneIndex is 0; passing 1 must revert
      let reverted = false;
      try {
        await c.connect(stranger).resolveVote(1);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("anyone (stranger) can call resolveVote after the deadline", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      // Must not revert for stranger
      await c.connect(stranger).resolveVote(0);
      const m = await c.getMilestone(0);
      expect(m.state).to.not.equal(2n); // no longer RevealOpen
    });

    it("reverts when called a second time on the same (already resolved) milestone", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0); // succeeds
      let reverted = false;
      try {
        await c.connect(stranger).resolveVote(0); // second call must revert
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ── 2. QUORUM CHECK ───────────────────────────────────────────

  describe("quorum check", function () {
    it("sets state to Inconclusive when participation < 20 %", async function () {
      // investor1 has 1 900 tokens = 19 % < 20 % quorum
      const c = await deployQuorumFailCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);
      const m = await c.getMilestone(0);
      expect(m.state).to.equal(5n); // MilestoneState.Inconclusive = 5
    });

    it("emits MilestoneFailed event on Inconclusive", async function () {
      const c = await deployQuorumFailCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      const tx      = await c.connect(stranger).resolveVote(0);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("null receipt");
      const log = receipt.logs.find((l: any) => {
        try {
          return c.interface.parseLog(l)?.name === "MilestoneFailed";
        } catch {
          return false;
        }
      });
      expect(log).to.not.be.undefined;
    });

    it("does not advance currentMilestoneIndex on Inconclusive", async function () {
      const c = await deployQuorumFailCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.currentMilestoneIndex()).to.equal(0n);
    });

    it("does not slash founder stake on Inconclusive", async function () {
      const c          = await deployQuorumFailCampaign();
      const stakeBefore = await c.founderStake();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.founderStake()).to.equal(stakeBefore);
    });

    it("early return on Inconclusive — penaltyDeducted is NOT set", async function () {
      // resolveVote returns after the quorum check, before penalty accounting
      const c = await deployQuorumFailCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.penaltyDeducted(0, investor2Addr)).to.equal(0n);
    });

    it("resolves normally when participation is exactly at the 20 % boundary", async function () {
      // investor1 = 0.2 ETH → 2 000 tokens = exactly 20 %
      const dl      = await freshDeadline();
      const Factory = await ethers.getContractFactory("CampaignV2", founder);
      const c = await Factory.deploy(
        founderAddr, oracleAddr, "T", "D", goal, dl,
        "T", "T", ["M1", "M2"], [5000, 5000],
        { value: goal / 10n }
      );
      await c.connect(investor1).invest({ value: ethers.parseEther("0.2") });
      await c.connect(investor2).invest({ value: ethers.parseEther("0.8") });

      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);
      const m = await c.getMilestone(0);
      // 2000/10000 is NOT < QUORUM_PERCENT → must not be Inconclusive
      expect(m.state).to.not.equal(5n);
    });
  });

  // ── 3. PASS PATH ──────────────────────────────────────────────
  //
  // investor1 (6 000 tokens) votes 8 000
  // investor2 (4 000 tokens) votes 6 000
  // avgProb = (8000×6000 + 6000×4000) / 10 000 = 7 200 ≥ 5 100 → PASS

  describe("pass path", function () {
    let campaign: any;

    beforeEach(async function () {
      campaign = await deployFundedCampaign();
      await runVotingCycle(campaign, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
    });

    it("sets milestone state to Passed (3)", async function () {
      await campaign.connect(stranger).resolveVote(0);
      const m = await campaign.getMilestone(0);
      expect(m.state).to.equal(3n); // MilestoneState.Passed
    });

    it("advances currentMilestoneIndex from 0 to 1", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.currentMilestoneIndex()).to.equal(1n);
    });

    it("emits MilestonePassed with the correct ethAllocation", async function () {
      const tx      = await campaign.connect(stranger).resolveVote(0);
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
      // 50 % of 1 ETH raised = 0.5 ETH
      expect(parsed.args[1]).to.equal(ethers.parseEther("0.5"));
    });

    it("does NOT slash founder stake on pass", async function () {
      const stakeBefore = await campaign.founderStake();
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.founderStake()).to.equal(stakeBefore);
    });

    it("does NOT set stakeHeldUntil (non-suspicious agreement)", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.stakeHeldUntil(0)).to.equal(0n);
    });

    it("campaignState stays Funded after first of two milestones passes", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.campaignState()).to.equal(1n); // CampaignState.Funded
    });

    it("revealedVoterCount equals the number of voters who revealed", async function () {
      expect(await campaign.revealedVoterCount(0)).to.equal(2n);
    });
  });

  // ── 4. FAIL PATH (non-suspicious) ────────────────────────────
  //
  // investor1 (6 000 tokens) votes 2 000
  // investor2 (4 000 tokens) votes 3 000
  // avgProb = (2000×6000 + 3000×4000) / 10 000 = 2 400 < 5 100 → FAIL
  // agentScore = 7 000 → agentOutcome = 10 000 (≥5000)
  // suspicious = (0 ≠ 10000) && (7000 > 7500 || 7000 < 2500) = false → NOT suspicious

  describe("fail path (non-suspicious)", function () {
    let campaign: any;

    beforeEach(async function () {
      campaign = await deployFundedCampaign();
      await runVotingCycle(campaign, 0, 7000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
    });

    it("sets milestone state to Failed (4)", async function () {
      await campaign.connect(stranger).resolveVote(0);
      const m = await campaign.getMilestone(0);
      expect(m.state).to.equal(4n); // MilestoneState.Failed
    });

    it("does NOT advance currentMilestoneIndex", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.currentMilestoneIndex()).to.equal(0n);
    });

    it("emits MilestoneFailed event", async function () {
      const tx      = await campaign.connect(stranger).resolveVote(0);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("null receipt");
      const log = receipt.logs.find((l: any) => {
        try {
          return campaign.interface.parseLog(l)?.name === "MilestoneFailed";
        } catch {
          return false;
        }
      });
      expect(log).to.not.be.undefined;
    });

    it("sets founderStake to zero (full slash)", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.founderStake()).to.equal(0n);
    });

    it("emits FounderStakeSlashed event", async function () {
      const tx      = await campaign.connect(stranger).resolveVote(0);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("null receipt");
      const log = receipt.logs.find((l: any) => {
        try {
          return campaign.interface.parseLog(l)?.name === "FounderStakeSlashed";
        } catch {
          return false;
        }
      });
      expect(log).to.not.be.undefined;
    });

    it("assigns stakeSlashShare proportional to token holdings", async function () {
      const stake = await campaign.founderStake(); // 0.1 ETH
      await campaign.connect(stranger).resolveVote(0);

      const share1 = await campaign.stakeSlashShare(0, investor1Addr);
      const share2 = await campaign.stakeSlashShare(0, investor2Addr);

      // investor1 owns 60 % of supply
      expect(share1).to.equal((6000n * stake) / 10000n);
      // investor2 owns 40 % of supply
      expect(share2).to.equal((4000n * stake) / 10000n);
    });

    it("total stakeSlashShares sum exactly to the slashed amount", async function () {
      const stake = await campaign.founderStake();
      await campaign.connect(stranger).resolveVote(0);

      const share1 = await campaign.stakeSlashShare(0, investor1Addr);
      const share2 = await campaign.stakeSlashShare(0, investor2Addr);
      expect(share1 + share2).to.equal(stake);
    });

    it("does NOT set stakeHeldUntil", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.stakeHeldUntil(0)).to.equal(0n);
    });

    it("stakeSlashShare for a non-investor address remains 0", async function () {
      await campaign.connect(stranger).resolveVote(0);
      expect(await campaign.stakeSlashShare(0, oracleAddr)).to.equal(0n);
    });
  });

  // ── 5. COLLUSION DETECTION ────────────────────────────────────

  describe("collusion detection", function () {
    it("sets stakeHeldUntil when oracle > 7500 (very confident YES) but vote FAILS", async function () {
      // agentScore = 9 000 → agentOutcome = 10 000; vote outcome = 0 → suspicious
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 9000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      const tx    = await c.connect(stranger).resolveVote(0);
      const block = await ethers.provider.getBlock(tx.blockNumber!);
      expect(block).to.not.be.null;

      const held = await c.stakeHeldUntil(0);
      expect(held).to.equal(BigInt(block!.timestamp) + CHALLENGE_PERIOD);
    });

    it("sets stakeHeldUntil when oracle < 2500 (very confident NO) but vote PASSES", async function () {
      // agentScore = 1 000 → agentOutcome = 0; vote outcome = 10 000 → suspicious
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 1000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      const tx    = await c.connect(stranger).resolveVote(0);
      const block = await ethers.provider.getBlock(tx.blockNumber!);
      expect(block).to.not.be.null;

      const held = await c.stakeHeldUntil(0);
      expect(held).to.equal(BigInt(block!.timestamp) + CHALLENGE_PERIOD);
    });

    it("stakeHeldUntil is exactly 14 days from the resolve block timestamp", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 9000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      const tx    = await c.connect(stranger).resolveVote(0);
      const block = await ethers.provider.getBlock(tx.blockNumber!);
      const held  = await c.stakeHeldUntil(0);
      expect(Number(held) - block!.timestamp).to.equal(14 * 24 * 60 * 60);
    });

    it("does NOT set stakeHeldUntil when oracle is lukewarm (7 000) — not extreme enough", async function () {
      // suspicious = (outcome≠agentOutcome) && (7000>7500 || 7000<2500) = false
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.stakeHeldUntil(0)).to.equal(0n);
    });

    it("does NOT set stakeHeldUntil when oracle is 3 000 (not extreme, disagrees with pass)", async function () {
      // agentScore 3000 → agentOutcome 0; vote passes; not extreme → not suspicious
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 3000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.stakeHeldUntil(0)).to.equal(0n);
    });

    it("does NOT set stakeHeldUntil when oracle and vote both agree YES", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.stakeHeldUntil(0)).to.equal(0n);
    });

    it("does NOT set stakeHeldUntil when oracle and vote both agree NO", async function () {
      // agentScore 2000 → agentOutcome 0; vote also 0 → agree, not suspicious
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 2000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.stakeHeldUntil(0)).to.equal(0n);
    });

    it("does NOT slash stake when suspicious — stake is held, not zeroed", async function () {
      const c          = await deployFundedCampaign();
      const stakeBefore = await c.founderStake();
      await runVotingCycle(c, 0, 9000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.founderStake()).to.equal(stakeBefore);
    });

    it("stakeSlashShare is 0 for all investors when suspicious", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 9000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.stakeSlashShare(0, investor1Addr)).to.equal(0n);
      expect(await c.stakeSlashShare(0, investor2Addr)).to.equal(0n);
    });

    it("milestone state is still Failed when suspicious (state unaffected by suspicion)", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 9000, [
        { signer: investor1, prob: 2000, salt: SALT1 },
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      const m = await c.getMilestone(0);
      expect(m.state).to.equal(4n); // Failed — suspicious only affects stake
    });
  });

  // ── 6. REPUTATION UPDATES ────────────────────────────────────

  describe("reputation updates", function () {
    it("accurate voter earns higher reputation than inaccurate voter", async function () {
      // outcome = PASS (7200); investor1 votes 8000 (accurate), investor2 votes 2000 (inaccurate)
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 2000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const token = await ethers.getContractAt("CampaignTokenV2", await c.token());
      const rep1  = await token.getReputationScore(investor1Addr);
      const rep2  = await token.getReputationScore(investor2Addr);
      expect(rep1).to.be.gt(rep2);
    });

    it("investor1 reputation matches exact brierScore math (votes 8000, PASS outcome)", async function () {
      // BS(8000, 10000) = (8000-10000)²/10000 = 4_000_000/10000 = 400
      // perf = 10000 - 400 = 9600  → first vote sets rep directly to 9600
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const token = await ethers.getContractAt("CampaignTokenV2", await c.token());
      expect(await token.getReputationScore(investor1Addr)).to.equal(9600n);
    });

    it("investor2 reputation matches exact brierScore math (votes 6000, PASS outcome)", async function () {
      // BS(6000, 10000) = (6000-10000)²/10000 = 16_000_000/10000 = 1600
      // perf = 10000 - 1600 = 8400
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const token = await ethers.getContractAt("CampaignTokenV2", await c.token());
      expect(await token.getReputationScore(investor2Addr)).to.equal(8400n);
    });

    it("perfect NO voter (prob=0, FAIL outcome) earns reputation 10000", async function () {
      // BS(0, 0) = 0 → perf = 10000
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 0,    salt: SALT1 }, // perfect NO
        { signer: investor2, prob: 3000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const token = await ethers.getContractAt("CampaignTokenV2", await c.token());
      expect(await token.getReputationScore(investor1Addr)).to.equal(10000n);
    });

    it("voteParticipationCount increments for every revealed voter", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const token = await ethers.getContractAt("CampaignTokenV2", await c.token());
      expect(await token.voteParticipationCount(investor1Addr)).to.equal(1n);
      expect(await token.voteParticipationCount(investor2Addr)).to.equal(1n);
    });

    it("non-voter reputation is unchanged (stays at neutral 5000)", async function () {
      // Only investor1 reveals; investor2 does not commit or reveal
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        // investor2 intentionally omitted
      ]);
      await c.connect(stranger).resolveVote(0);

      const token = await ethers.getContractAt("CampaignTokenV2", await c.token());
      expect(await token.getReputationScore(investor2Addr)).to.equal(5000n);
      expect(await token.voteParticipationCount(investor2Addr)).to.equal(0n);
    });
  });

  // ── 7. NON-VOTER PENALTY ACCOUNTING ──────────────────────────

  describe("non-voter penalty accounting", function () {
    it("penaltyDeducted = 5 % of investedAmount for investor who did not reveal", async function () {
      // Only investor1 reveals; investor2 does not
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);

      // investor2 invested 0.4 ETH → penalty = 0.4 × 500 / 10000 = 0.02 ETH
      const expected = (ethers.parseEther("0.4") * NONVOTER_PENALTY) / SCALE;
      expect(await c.penaltyDeducted(0, investor2Addr)).to.equal(expected);
    });

    it("penaltyDeducted = 0 for investors who did reveal", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.penaltyDeducted(0, investor1Addr)).to.equal(0n);
      expect(await c.penaltyDeducted(0, investor2Addr)).to.equal(0n);
    });

    it("investor1 penalty correct when investor1 is the non-voter", async function () {
      // Only investor2 reveals; investor1 does not
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor2, prob: 8000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      // investor1 invested 0.6 ETH → penalty = 0.6 × 500 / 10000 = 0.03 ETH
      const expected = (ethers.parseEther("0.6") * NONVOTER_PENALTY) / SCALE;
      expect(await c.penaltyDeducted(0, investor1Addr)).to.equal(expected);
    });

    it("both investors penalised when neither votes (would need RevealOpen to resolve)", async function () {
      // This case cannot be triggered directly (no reveal → state stays VotingOpen → resolveVote reverts)
      // Instead verify: when only one investor votes, only the other is penalised
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);

      expect(await c.penaltyDeducted(0, investor1Addr)).to.equal(0n);
      expect(await c.penaltyDeducted(0, investor2Addr)).to.be.gt(0n);
    });
  });

  // ── 8. PARTICIPATION REWARD DISTRIBUTION ─────────────────────

  describe("participation reward distribution", function () {
    it("rewards are 0 when every investor voted (empty penalty pool)", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.participationReward(0, investor1Addr)).to.equal(0n);
      expect(await c.participationReward(0, investor2Addr)).to.equal(0n);
    });

    it("sole voter receives the entire non-voter penalty pool", async function () {
      // investor1 votes; investor2 does not → pool = 0.4 ETH × 5 % = 0.02 ETH
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const pool    = (ethers.parseEther("0.4") * NONVOTER_PENALTY) / SCALE;
      const reward1 = await c.participationReward(0, investor1Addr);
      expect(reward1).to.equal(pool);
    });

    it("accurate voter earns strictly more reward than inaccurate voter", async function () {
      // 3-investor campaign so investor3 is the non-voter funding the pool
      // investor1 (5000 tokens) votes 8000 → accurate for PASS
      // investor2 (3000 tokens) votes 2000 → inaccurate for PASS
      // investor3 (2000 tokens) does NOT vote → penalty funds the pool
      // avg = (8000×5000 + 2000×3000) / 8000 = 5750 ≥ 5100 → PASS
      const dl      = await freshDeadline();
      const Factory = await ethers.getContractFactory("CampaignV2", founder);
      const c = await Factory.deploy(
        founderAddr, oracleAddr, "T", "D", goal, dl,
        "T", "T", ["M1", "M2"], [5000, 5000],
        { value: goal / 10n }
      );
      await c.connect(investor1).invest({ value: ethers.parseEther("0.5") });
      await c.connect(investor2).invest({ value: ethers.parseEther("0.3") });
      await c.connect(investor3).invest({ value: ethers.parseEther("0.2") });

      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 2000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const reward1 = await c.participationReward(0, investor1Addr);
      const reward2 = await c.participationReward(0, investor2Addr);
      expect(reward1).to.be.gt(reward2);
    });

    it("participationReward is 0 for non-voters", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);
      // investor2 never revealed
      expect(await c.participationReward(0, investor2Addr)).to.equal(0n);
    });

    it("total rewards distributed do not exceed the penalty pool", async function () {
      // investor3 is the non-voter; pool = 0.2 ETH × 5 % = 0.01 ETH
      const dl      = await freshDeadline();
      const Factory = await ethers.getContractFactory("CampaignV2", founder);
      const c = await Factory.deploy(
        founderAddr, oracleAddr, "T", "D", goal, dl,
        "T", "T", ["M1", "M2"], [5000, 5000],
        { value: goal / 10n }
      );
      await c.connect(investor1).invest({ value: ethers.parseEther("0.5") });
      await c.connect(investor2).invest({ value: ethers.parseEther("0.3") });
      await c.connect(investor3).invest({ value: ethers.parseEther("0.2") });

      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 6000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const pool    = (ethers.parseEther("0.2") * NONVOTER_PENALTY) / SCALE;
      const reward1 = await c.participationReward(0, investor1Addr);
      const reward2 = await c.participationReward(0, investor2Addr);
      // Sum may be slightly below pool due to integer division dust
      expect(reward1 + reward2).to.be.lte(pool);
    });
  });

  // ── 9. MULTI-MILESTONE PROGRESSION ───────────────────────────

  describe("multi-milestone progression", function () {
    it("currentMilestoneIndex advances to 1 after milestone 0 passes", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.currentMilestoneIndex()).to.equal(1n);
    });

    it("campaignState becomes Completed after the LAST milestone passes", async function () {
      const c = await deployFundedCampaign(); // 2 milestones

      // Milestone 0 → PASS
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.campaignState()).to.equal(1n); // still Funded

      // Milestone 1 → PASS
      await runVotingCycle(c, 1, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1B },
        { signer: investor2, prob: 7000, salt: SALT2B },
      ]);
      await c.connect(stranger).resolveVote(1);
      expect(await c.campaignState()).to.equal(2n); // CampaignState.Completed
    });

    it("second milestone agent score can be submitted after first milestone resolves", async function () {
      const c = await deployFundedCampaign();
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);

      // submitAgentScore for milestone 1 must succeed
      await c.connect(oracle).submitAgentScore(1, 7500);
      const m1 = await c.getMilestone(1);
      expect(m1.agentScoreSubmitted).to.equal(true);
      expect(m1.agentScore).to.equal(7500n);
    });

    it("revealedVoterCount is tracked independently per milestone", async function () {
      const c = await deployFundedCampaign();

      // Milestone 0 — both investors reveal
      await runVotingCycle(c, 0, 8000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
        { signer: investor2, prob: 7000, salt: SALT2 },
      ]);
      await c.connect(stranger).resolveVote(0);
      expect(await c.revealedVoterCount(0)).to.equal(2n);

      // Milestone 1 — only investor1 reveals
      await c.connect(oracle).submitAgentScore(1, 8000);
      await c.connect(founder).startMilestoneVote();
      await c.connect(investor1).commitVote(1, makeHash(8000, SALT1B));
      await networkHelpers.mine(COMMIT_DURATION + 1);
      await c.connect(investor1).revealVote(1, 8000, SALT1B);
      await networkHelpers.mine(REVEAL_DURATION + 1);

      expect(await c.revealedVoterCount(1)).to.equal(1n);
    });

    it("Inconclusive leaves currentMilestoneIndex unchanged so vote can restart", async function () {
      const c = await deployQuorumFailCampaign();
      await runVotingCycle(c, 0, 7000, [
        { signer: investor1, prob: 8000, salt: SALT1 },
      ]);
      await c.connect(stranger).resolveVote(0);

      const m = await c.getMilestone(0);
      expect(m.state).to.equal(5n); // Inconclusive
      expect(await c.currentMilestoneIndex()).to.equal(0n);
    });
  });
});
