// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title BrierMath
 * @notice Fixed-point math library for Brier Score calculation.
 *
 * All values use a SCALE of 10_000.
 * Probability 1.0  = 10_000
 * Probability 0.0  = 0
 * Probability 0.75 = 7_500
 *
 * THE BRIER SCORE:
 *   BS = (probability - outcome)²
 *
 *   Where outcome is either 0 (vote failed) or 10_000 (vote passed).
 *   Lower score = more accurate prediction.
 *   Range: 0 (perfect) to 10_000 (worst possible).
 *
 * WHY THIS IS GAME-THEORETICALLY IMPORTANT:
 *   The Brier Score is a *strictly proper scoring rule*.
 *   This means the mathematically optimal strategy for any
 *   rational voter is to report their TRUE belief.
 *
 *   Proof sketch:
 *   If your true belief is q, and you report p, your
 *   expected Brier Score is:
 *     E[BS] = q*(p - 10000)² + (1-q)*(p - 0)²
 *   Taking dE/dp = 0 gives p = q.
 *   Any deviation from your true belief increases expected score.
 *   Higher score = worse performance = smaller reward.
 *   Therefore truthful reporting is the dominant strategy. QED.
 *
 * PERFORMANCE SCORE (used for rewards):
 *   performanceScore = 10_000 - brierScore
 *   Range: 0 (worst) to 10_000 (perfect).
 *   This inversion makes higher = better for reward calculations.
 */
library BrierMath {

    /// @notice Scale factor. All probabilities are 0–10_000.
    uint256 public constant SCALE = 10_000;

    /**
     * @notice Calculate the Brier Score for a single prediction.
     *
     * Formula: BS = (probability - outcome)² / SCALE
     *
     * Division by SCALE at the end normalizes the result back
     * into the 0–10_000 range after squaring.
     *
     * Without normalization:
     *   Max raw: (10_000 - 0)² = 100_000_000
     * After dividing by SCALE (10_000):
     *   Max normalized: 100_000_000 / 10_000 = 10_000 ✓
     *
     * @param probability  Voter's stated probability, 0–10_000
     * @param outcome      Actual outcome: 0 (failed) or 10_000 (passed)
     * @return score       Brier Score, 0–10_000. Lower = more accurate.
     */
    function brierScore(
        uint256 probability,
        uint256 outcome
    ) internal pure returns (uint256 score) {
        require(
            probability <= SCALE,
            "BrierMath: probability out of range"
        );
        require(
            outcome == 0 || outcome == SCALE,
            "BrierMath: outcome must be 0 or 10000"
        );

        // Use int256 for subtraction to handle underflow safely.
        // probability and outcome are both <= 10_000 so the cast is safe.
        int256 diff = int256(probability) - int256(outcome);

        // diff² is always positive regardless of sign.
        // Max value: 10_000² = 100_000_000 — well within uint256.
        uint256 squared = uint256(diff * diff);

        // Normalize back to 0–10_000 range.
        score = squared / SCALE;
    }

    /**
     * @notice Convert a Brier Score into a Performance Score.
     *
     * performanceScore = SCALE - brierScore
     *
     * This inverts the scale so that:
     *   Perfect prediction (BS=0)    → performance = 10_000
     *   Worst prediction  (BS=10000) → performance = 0
     *
     * Used to calculate participation reward shares —
     * higher performance = larger share of reward pool.
     *
     * @param score  Brier Score, 0–10_000
     * @return       Performance Score, 0–10_000
     */
    function toPerformanceScore(
        uint256 score
    ) internal pure returns (uint256) {
        require(score <= SCALE, "BrierMath: score out of range");
        return SCALE - score;
    }

    /**
     * @notice Calculate a voter's share of the reward pool.
     *
     * Uses reputation-weighted performance:
     *   weight = performanceScore * reputationScore
     *   share  = (weight * rewardPool) / totalWeight
     *
     * Both performanceScore and reputationScore are 0–10_000.
     * Their product can reach 10_000 * 10_000 = 100_000_000.
     * We divide by SCALE once to bring it back to 0–10_000.
     *
     * This means:
     *   - Accurate voter with high reputation → largest share
     *   - Accurate voter with no history      → medium share
     *   - Inaccurate voter                    → smallest share
     *
     * @param performanceScore  This voter's performance, 0–10_000
     * @param reputationScore   This voter's reputation, 0–10_000
     * @param rewardPool        Total ETH available to distribute (wei)
     * @param totalWeight       Sum of all voters' weights
     * @return                  This voter's reward in wei
     */
    function calculateRewardShare(
        uint256 performanceScore,
        uint256 reputationScore,
        uint256 rewardPool,
        uint256 totalWeight
    ) internal pure returns (uint256) {
        if (totalWeight == 0) return 0;
        if (rewardPool == 0) return 0;

        // Weight for this voter: performance * reputation / SCALE
        // Divided by SCALE to keep in 0–10_000 range after multiply
        uint256 weight = (performanceScore * reputationScore) / SCALE;

        // Share: (weight / totalWeight) * rewardPool
        // Multiply before divide to preserve precision
        return (weight * rewardPool) / totalWeight;
    }
}