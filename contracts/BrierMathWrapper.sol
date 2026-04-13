// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./BrierMath.sol";

/**
 * @title BrierMathWrapper
 * @notice Test-only contract that exposes BrierMath library
 * functions as public so they can be called from JS tests.
 * Never deploy this to mainnet.
 */
contract BrierMathWrapper {
    function brierScore(
        uint256 probability,
        uint256 outcome
    ) public pure returns (uint256) {
        return BrierMath.brierScore(probability, outcome);
    }

    function toPerformanceScore(
        uint256 score
    ) public pure returns (uint256) {
        return BrierMath.toPerformanceScore(score);
    }

    function calculateRewardShare(
        uint256 performanceScore,
        uint256 reputationScore,
        uint256 rewardPool,
        uint256 totalWeight
    ) public pure returns (uint256) {
        return BrierMath.calculateRewardShare(
            performanceScore,
            reputationScore,
            rewardPool,
            totalWeight
        );
    }
}