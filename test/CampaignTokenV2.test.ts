import { expect } from "chai";
import hre from "hardhat";
import type { CampaignTokenV2 } from "../types/ethers-contracts/index.js";

describe("CampaignTokenV2", function () {
  let ethers: Awaited<ReturnType<typeof hre.network.connect>>["ethers"];

  let campaignAddress: string;
  let investor1Address: string;
  let investor2Address: string;
  let strangerAddress: string;

  let campaign: Awaited<ReturnType<typeof ethers.getSigners>>[0];
  let investor1: Awaited<ReturnType<typeof ethers.getSigners>>[0];
  let investor2: Awaited<ReturnType<typeof ethers.getSigners>>[0];
  let stranger: Awaited<ReturnType<typeof ethers.getSigners>>[0];

  let token: CampaignTokenV2;

  const TOKEN_NAME = "GreenGrid Token";
  const TOKEN_SYMBOL = "GGT";
  const TOTAL_SUPPLY = BigInt("10000") * BigInt(10 ** 18);

  before(async function () {
    const connection = await hre.network.connect();
    ethers = connection.ethers;
  });

  beforeEach(async function () {
    [campaign, investor1, investor2, stranger] = await ethers.getSigners();

    campaignAddress = await campaign.getAddress();
    investor1Address = await investor1.getAddress();
    investor2Address = await investor2.getAddress();
    strangerAddress = await stranger.getAddress();

    const Factory = await ethers.getContractFactory(
      "CampaignTokenV2",
      campaign
    );
    token = (await Factory.deploy(
      TOKEN_NAME,
      TOKEN_SYMBOL,
      campaignAddress
    )) as unknown as CampaignTokenV2;
    await token.waitForDeployment();
  });

  // ── 1. DEPLOYMENT ─────────────────────────────────────────────

  describe("Deployment", function () {
    it("should set the correct token name", async function () {
      expect(await token.name()).to.equal(TOKEN_NAME);
    });

    it("should set the correct token symbol", async function () {
      expect(await token.symbol()).to.equal(TOKEN_SYMBOL);
    });

    it("should set the campaign address as owner", async function () {
      expect(await token.owner()).to.equal(campaignAddress);
    });

    it("should have 18 decimals", async function () {
      expect(await token.decimals()).to.equal(18n);
    });

    it("should have correct TOTAL_SUPPLY constant", async function () {
      expect(await token.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
    });
  });

  // ── 2. SUPPLY ─────────────────────────────────────────────────

  describe("Supply", function () {
    it("should mint entire supply to campaign on deploy", async function () {
      expect(await token.balanceOf(campaignAddress)).to.equal(TOTAL_SUPPLY);
    });

    it("total supply should equal TOTAL_SUPPLY", async function () {
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    });

    it("investor1 should start with zero balance", async function () {
      expect(await token.balanceOf(investor1Address)).to.equal(0n);
    });

    it("should transfer tokens from campaign to investor", async function () {
      const amount = 1000n * 10n ** 18n;
      await token.connect(campaign).transfer(investor1Address, amount);
      expect(await token.balanceOf(investor1Address)).to.equal(amount);
    });

    it("total supply unchanged after transfer", async function () {
      const amount = 1000n * 10n ** 18n;
      await token.connect(campaign).transfer(investor1Address, amount);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    });
  });

  // ── 3. REPUTATION ─────────────────────────────────────────────

  describe("Reputation System", function () {
    it("should return 5000 for address with no history", async function () {
      expect(await token.getReputationScore(investor1Address)).to.equal(5000n);
    });

    it("should return 5000 for any unknown address", async function () {
      expect(await token.getReputationScore(strangerAddress)).to.equal(5000n);
    });

    it("should set score directly on first vote", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 8000);
      expect(await token.getReputationScore(investor1Address)).to.equal(8000n);
    });

    it("voteParticipationCount should be 0 before any votes", async function () {
      expect(await token.voteParticipationCount(investor1Address)).to.equal(0n);
    });

    it("voteParticipationCount should increment after updateReputation", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 8000);
      expect(await token.voteParticipationCount(investor1Address)).to.equal(1n);
    });

    it("should calculate weighted average on second vote", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 8000);
      await token.connect(campaign).updateReputation(investor1Address, 6000);
      // (8000*1 + 6000) / 2 = 7000
      expect(await token.getReputationScore(investor1Address)).to.equal(7000n);
    });

    it("should correctly average across 3 votes", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 8000);
      await token.connect(campaign).updateReputation(investor1Address, 6000);
      await token.connect(campaign).updateReputation(investor1Address, 4000);
      // After 3rd: (7000*2 + 4000)/3 = 6000
      expect(await token.getReputationScore(investor1Address)).to.equal(6000n);
    });

    it("should cap at 10000", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 10000);
      await token.connect(campaign).updateReputation(investor1Address, 10000);
      expect(await token.getReputationScore(investor1Address)).to.be.lte(
        10000n
      );
    });

    it("should handle score of 0", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 0);
      expect(await token.getReputationScore(investor1Address)).to.equal(0n);
    });

    it("should track reputation independently per investor", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 9000);
      await token.connect(campaign).updateReputation(investor2Address, 3000);
      expect(await token.getReputationScore(investor1Address)).to.equal(9000n);
      expect(await token.getReputationScore(investor2Address)).to.equal(3000n);
    });

    it("should revert if performance score exceeds 10000", async function () {
      let reverted = false;
      try {
        await token.connect(campaign).updateReputation(investor1Address, 10001);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("100 updates should not overflow", async function () {
      for (let i = 0; i < 100; i++) {
        await token.connect(campaign).updateReputation(investor1Address, 5000);
      }
      const score = await token.getReputationScore(investor1Address);
      expect(score).to.be.lte(10000n);
    });
  });

  // ── 4. BURN ───────────────────────────────────────────────────

  describe("Burn", function () {
    const investorTokens = 1000n * 10n ** 18n;

    beforeEach(async function () {
      await token.connect(campaign).transfer(investor1Address, investorTokens);
    });

    it("owner can burn investor tokens", async function () {
      await token.connect(campaign).burn(investor1Address, investorTokens);
      expect(await token.balanceOf(investor1Address)).to.equal(0n);
    });

    it("burning reduces total supply", async function () {
      await token.connect(campaign).burn(investor1Address, investorTokens);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY - investorTokens);
    });

    it("burning partial amount leaves correct balance", async function () {
      const burnAmount = 500n * 10n ** 18n;
      await token.connect(campaign).burn(investor1Address, burnAmount);
      expect(await token.balanceOf(investor1Address)).to.equal(
        investorTokens - burnAmount
      );
    });

    it("should revert if burn exceeds balance", async function () {
      let reverted = false;
      try {
        await token
          .connect(campaign)
          .burn(investor1Address, investorTokens + 1n);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ── 5. ACCESS CONTROL ─────────────────────────────────────────

  describe("Access Control", function () {
    it("stranger cannot call updateReputation", async function () {
      let reverted = false;
      try {
        await token.connect(stranger).updateReputation(investor1Address, 8000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("investor cannot call updateReputation on themselves", async function () {
      let reverted = false;
      try {
        await token.connect(investor1).updateReputation(investor1Address, 8000);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("stranger cannot burn tokens", async function () {
      const amount = 100n * 10n ** 18n;
      await token.connect(campaign).transfer(investor1Address, amount);
      let reverted = false;
      try {
        await token.connect(stranger).burn(investor1Address, amount);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });

    it("non-owner cannot transfer ownership", async function () {
      let reverted = false;
      try {
        await token.connect(stranger).transferOwnership(strangerAddress);
      } catch {
        reverted = true;
      }
      expect(reverted).to.equal(true);
    });
  });

  // ── 6. EDGE CASES ─────────────────────────────────────────────

  describe("Edge Cases", function () {
    it("raw reputationScore mapping returns 0 for unknown address", async function () {
      expect(await token.reputationScore(strangerAddress)).to.equal(0n);
      expect(await token.getReputationScore(strangerAddress)).to.equal(5000n);
    });

    it("exact 10000 score should not be capped incorrectly", async function () {
      await token.connect(campaign).updateReputation(investor1Address, 10000);
      expect(await token.getReputationScore(investor1Address)).to.equal(10000n);
    });

    it("investors can transfer tokens to each other", async function () {
      const amount = 1000n * 10n ** 18n;
      const transferAmount = 200n * 10n ** 18n;
      await token.connect(campaign).transfer(investor1Address, amount);
      await token.connect(investor1).transfer(investor2Address, transferAmount);
      expect(await token.balanceOf(investor1Address)).to.equal(
        amount - transferAmount
      );
      expect(await token.balanceOf(investor2Address)).to.equal(transferAmount);
    });
  });
});
