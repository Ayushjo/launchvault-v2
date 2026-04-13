import { expect } from "chai";
import hre from "hardhat";

/**
 * BrierMath Test Suite
 *
 * We test through a thin wrapper contract because Solidity
 * libraries with internal functions can't be called directly
 * from JS. The wrapper just exposes them as public functions.
 *
 * Test groups:
 *   1. brierScore() — core math
 *   2. toPerformanceScore() — inversion
 *   3. calculateRewardShare() — distribution
 *   4. Edge cases and boundary values
 */
describe("BrierMath", function () {
  let ethers: Awaited<ReturnType<typeof hre.network.connect>>["ethers"];
  let math: any;

  const SCALE = 10_000n;

  before(async function () {
    const connection = await hre.network.connect();
    ethers = connection.ethers;
  });

  beforeEach(async function () {
    const Factory = await ethers.getContractFactory("BrierMathWrapper");
    math = await Factory.deploy();
    await math.waitForDeployment();
  });

  // ── 1. brierScore() ───────────────────────────────────────────

  describe("brierScore()", function () {

    // Perfect predictions
    it("perfect YES prediction: prob=10000, outcome=10000 → score=0", async function () {
      expect(await math.brierScore(10000, 10000)).to.equal(0n);
    });

    it("perfect NO prediction: prob=0, outcome=0 → score=0", async function () {
      expect(await math.brierScore(0, 0)).to.equal(0n);
    });

    // Worst predictions
    it("worst YES prediction: prob=0, outcome=10000 → score=10000", async function () {
      // (0 - 10000)² / 10000 = 100_000_000 / 10_000 = 10_000
      expect(await math.brierScore(0, 10000)).to.equal(10000n);
    });

    it("worst NO prediction: prob=10000, outcome=0 → score=10000", async function () {
      // (10000 - 0)² / 10000 = 100_000_000 / 10_000 = 10_000
      expect(await math.brierScore(10000, 0)).to.equal(10000n);
    });

    // Neutral prediction (50/50)
    it("neutral prediction: prob=5000, outcome=10000 → score=2500", async function () {
      // (5000 - 10000)² / 10000 = 25_000_000 / 10_000 = 2_500
      expect(await math.brierScore(5000, 10000)).to.equal(2500n);
    });

    it("neutral prediction: prob=5000, outcome=0 → score=2500", async function () {
      // (5000 - 0)² / 10000 = 25_000_000 / 10_000 = 2_500
      expect(await math.brierScore(5000, 0)).to.equal(2500n);
    });

    // Specific calibration checks
    it("prob=7500, outcome=10000 → score=625", async function () {
      // (7500 - 10000)² / 10000 = 6_250_000 / 10_000 = 625
      expect(await math.brierScore(7500, 10000)).to.equal(625n);
    });

    it("prob=7500, outcome=0 → score=5625", async function () {
      // (7500 - 0)² / 10000 = 56_250_000 / 10_000 = 5_625
      expect(await math.brierScore(7500, 0)).to.equal(5625n);
    });

    it("prob=2500, outcome=0 → score=625", async function () {
      // (2500 - 0)² / 10000 = 6_250_000 / 10_000 = 625
      expect(await math.brierScore(2500, 0)).to.equal(625n);
    });

    it("prob=2500, outcome=10000 → score=5625", async function () {
      // (2500 - 10000)² / 10000 = 56_250_000 / 10_000 = 5_625
      expect(await math.brierScore(2500, 10000)).to.equal(5625n);
    });

    it("prob=9000, outcome=10000 → score=100", async function () {
      // (9000 - 10000)² / 10000 = 1_000_000 / 10_000 = 100
      expect(await math.brierScore(9000, 10000)).to.equal(100n);
    });

    it("prob=1000, outcome=0 → score=100", async function () {
      // (1000 - 0)² / 10000 = 1_000_000 / 10_000 = 100
      expect(await math.brierScore(1000, 0)).to.equal(100n);
    });

    // Score is symmetric around 5000
    it("score should be symmetric: brierScore(x, 10000) == brierScore(10000-x, 0)", async function () {
      const scoreA = await math.brierScore(3000, 10000);
      const scoreB = await math.brierScore(7000, 0);
      expect(scoreA).to.equal(scoreB);
    });

    // Result always in valid range
    it("score is always between 0 and 10000", async function () {
      const cases = [
        [0, 0], [0, 10000],
        [5000, 0], [5000, 10000],
        [10000, 0], [10000, 10000],
        [1, 0], [9999, 10000],
      ];
      for (const [p, o] of cases) {
        const score = await math.brierScore(p, o);
        expect(score).to.be.gte(0n);
        expect(score).to.be.lte(10000n);
      }
    });

    // Validation guards
    it("should revert if probability > 10000", async function () {
      let reverted = false;
      try { await math.brierScore(10001, 0); } catch { reverted = true; }
      expect(reverted).to.equal(true);
    });

    it("should revert if outcome is not 0 or 10000", async function () {
      let reverted = false;
      try { await math.brierScore(5000, 5000); } catch { reverted = true; }
      expect(reverted).to.equal(true);
    });

    it("should revert if outcome is 1", async function () {
      let reverted = false;
      try { await math.brierScore(5000, 1); } catch { reverted = true; }
      expect(reverted).to.equal(true);
    });
  });

  // ── 2. toPerformanceScore() ───────────────────────────────────

  describe("toPerformanceScore()", function () {
    it("Brier score 0 → performance 10000 (perfect)", async function () {
      expect(await math.toPerformanceScore(0)).to.equal(10000n);
    });

    it("Brier score 10000 → performance 0 (worst)", async function () {
      expect(await math.toPerformanceScore(10000)).to.equal(0n);
    });

    it("Brier score 2500 → performance 7500", async function () {
      expect(await math.toPerformanceScore(2500)).to.equal(7500n);
    });

    it("Brier score 5000 → performance 5000", async function () {
      expect(await math.toPerformanceScore(5000)).to.equal(5000n);
    });

    it("should revert if score > 10000", async function () {
      let reverted = false;
      try { await math.toPerformanceScore(10001); } catch { reverted = true; }
      expect(reverted).to.equal(true);
    });

    it("performance score is always in 0–10000 range", async function () {
      for (const score of [0, 1, 100, 2500, 5000, 7500, 9999, 10000]) {
        const perf = await math.toPerformanceScore(score);
        expect(perf).to.be.gte(0n);
        expect(perf).to.be.lte(10000n);
      }
    });
  });

  // ── 3. calculateRewardShare() ─────────────────────────────────

  describe("calculateRewardShare()", function () {
    it("equal performance and reputation → equal shares", async function () {
      const rewardPool = ethers.parseEther("1");
      // Two voters with identical weights
      // weight each = (8000 * 8000) / 10000 = 6400
      // totalWeight = 12800
      // share each = (6400 * 1e18) / 12800 = 0.5e18
      const weight = (8000n * 8000n) / SCALE; // 6400
      const totalWeight = weight * 2n;         // 12800

      const share = await math.calculateRewardShare(
        8000, 8000, rewardPool, totalWeight
      );
      expect(share).to.equal(rewardPool / 2n);
    });

    it("higher performance → larger share", async function () {
      const rewardPool = ethers.parseEther("1");
      // Voter A: performance=9000, reputation=5000
      // weight_A = (9000 * 5000) / 10000 = 4500
      // Voter B: performance=3000, reputation=5000
      // weight_B = (3000 * 5000) / 10000 = 1500
      // totalWeight = 6000
      const weightA = (9000n * 5000n) / SCALE; // 4500
      const weightB = (3000n * 5000n) / SCALE; // 1500
      const totalWeight = weightA + weightB;    // 6000

      const shareA = await math.calculateRewardShare(9000, 5000, rewardPool, totalWeight);
      const shareB = await math.calculateRewardShare(3000, 5000, rewardPool, totalWeight);

      expect(shareA).to.be.gt(shareB);
      // shareA should be 3x shareB (4500/1500 = 3)
      expect(shareA).to.equal(shareB * 3n);
    });

    it("higher reputation → larger share", async function () {
      const rewardPool = ethers.parseEther("1");
      // Same performance, different reputation
      const weightA = (7000n * 9000n) / SCALE; // 6300
      const weightB = (7000n * 3000n) / SCALE; // 2100
      const totalWeight = weightA + weightB;    // 8400

      const shareA = await math.calculateRewardShare(7000, 9000, rewardPool, totalWeight);
      const shareB = await math.calculateRewardShare(7000, 3000, rewardPool, totalWeight);

      expect(shareA).to.be.gt(shareB);
    });

    it("zero rewardPool → zero share", async function () {
      const share = await math.calculateRewardShare(8000, 8000, 0, 10000);
      expect(share).to.equal(0n);
    });

    it("zero totalWeight → zero share (no division by zero)", async function () {
      const rewardPool = ethers.parseEther("1");
      const share = await math.calculateRewardShare(8000, 8000, rewardPool, 0);
      expect(share).to.equal(0n);
    });

    it("shares sum to rewardPool (no dust for equal voters)", async function () {
      const rewardPool = ethers.parseEther("2");
      const weight = (8000n * 8000n) / SCALE;
      const totalWeight = weight * 2n;

      const s1 = await math.calculateRewardShare(8000, 8000, rewardPool, totalWeight);
      const s2 = await math.calculateRewardShare(8000, 8000, rewardPool, totalWeight);

      expect(s1 + s2).to.equal(rewardPool);
    });
  });

  // ── 4. EDGE CASES ─────────────────────────────────────────────

  describe("Edge Cases", function () {
    it("brierScore is monotonically worse as you deviate from truth (YES outcome)", async function () {
      // For outcome=10000, score should increase as probability decreases
      const s1 = await math.brierScore(10000, 10000); // perfect
      const s2 = await math.brierScore(8000, 10000);
      const s3 = await math.brierScore(5000, 10000);
      const s4 = await math.brierScore(2000, 10000);
      const s5 = await math.brierScore(0, 10000);     // worst

      expect(s1).to.be.lt(s2);
      expect(s2).to.be.lt(s3);
      expect(s3).to.be.lt(s4);
      expect(s4).to.be.lt(s5);
    });

    it("brierScore is monotonically worse as you deviate from truth (NO outcome)", async function () {
      const s1 = await math.brierScore(0, 0);       // perfect
      const s2 = await math.brierScore(2000, 0);
      const s3 = await math.brierScore(5000, 0);
      const s4 = await math.brierScore(8000, 0);
      const s5 = await math.brierScore(10000, 0);   // worst

      expect(s1).to.be.lt(s2);
      expect(s2).to.be.lt(s3);
      expect(s3).to.be.lt(s4);
      expect(s4).to.be.lt(s5);
    });

    it("truthful reporting minimizes expected score (incentive compatibility check)", async function () {
      // If true belief is 70% (7000), reporting 7000 should give
      // lower expected score than reporting 9000 or 5000
      // E[BS | report p, true belief q] = q*(p-10000)² + (1-q)*p²  / SCALE
      // We simulate with q=0.7: 70% chance outcome=10000, 30% chance outcome=0

      const q = 7000n; // true belief scaled

      function expectedScore(p: bigint): bigint {
        const scoreIfYes = (p - SCALE) * (p - SCALE) / SCALE;  // outcome=10000
        const scoreIfNo  = p * p / SCALE;                        // outcome=0
        // E = q/SCALE * scoreIfYes + (SCALE-q)/SCALE * scoreIfNo
        return (q * scoreIfYes + (SCALE - q) * scoreIfNo) / SCALE;
      }

      const truthful  = expectedScore(7000n);
      const overstate = expectedScore(9000n);
      const understate = expectedScore(5000n);

      expect(truthful).to.be.lt(overstate);
      expect(truthful).to.be.lt(understate);
    });
  });
});