// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title CampaignTokenV2
 * @notice ERC-20 governance token for a single LaunchVault campaign.
 *
 * Each campaign deploys its own token contract.
 * The Campaign contract is set as the owner and is the
 * only address that can mint or burn tokens.
 *
 * Tokens represent two things simultaneously:
 *   1. Proportional ownership share of the campaign
 *   2. Voting power in milestone governance votes
 *
 * New in V2:
 *   - reputationScore mapping: tracks how well each investor
 *     has historically predicted outcomes (via Brier scoring).
 *     Higher reputation = larger share of participation rewards.
 *   - updateReputation(): callable only by owner (Campaign contract)
 *     after each milestone resolution.
 *   - burn(): callable only by owner, needed for refund accounting.
 */
contract CampaignTokenV2 is ERC20, Ownable {

    // ─────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Total fixed supply minted at deployment.
     * 10,000 tokens per campaign — a clean unit for percentages.
     * An investor contributing 10% of the goal gets exactly
     * 1,000 tokens (10% of 10,000).
     *
     * Stored as a constant to avoid any possibility of the
     * supply being changed after deployment.
     */
    uint256 public constant TOTAL_SUPPLY = 10_000 * 10 ** 18;

    /**
     * @notice Cumulative reputation score per investor address.
     *
     * Scaled by 1e4 (same as our probability scale).
     * Starts at 5000 for every investor — neutral/unknown reputation.
     * Increases when voter is accurate, decreases when inaccurate.
     *
     * Used by CampaignV2 to weight participation rewards.
     * Higher reputation investors earn proportionally more
     * from the non-voter penalty pool.
     */
    mapping(address => uint256) public reputationScore;

    /**
     * @notice Track how many milestone votes each address
     * has participated in. Used alongside reputationScore
     * to distinguish "new investor, no history" from
     * "consistently bad predictor."
     */
    mapping(address => uint256) public voteParticipationCount;

    // ─────────────────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when the Campaign contract updates
     * an investor's reputation after a milestone resolution.
     * @param investor  The investor whose score changed
     * @param oldScore  Score before update
     * @param newScore  Score after update
     */
    event ReputationUpdated(
        address indexed investor,
        uint256 oldScore,
        uint256 newScore
    );

    // ─────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────

    /**
     * @param name_     Token name e.g. "GreenGrid Token"
     * @param symbol_   Token symbol e.g. "GGT"
     * @param campaign_ The CampaignV2 address that will own this token.
     *                  We pass this explicitly because at deploy time
     *                  the Campaign contract deploys the Token contract
     *                  from within its own constructor — so msg.sender
     *                  IS the Campaign address. We still accept it
     *                  explicitly for clarity and testability.
     *
     * All TOTAL_SUPPLY tokens are minted to the Campaign contract.
     * The Campaign contract distributes them to investors as they invest.
     * Tokens never leave the Campaign contract until an investment is made.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address campaign_
    ) ERC20(name_, symbol_) Ownable(campaign_) {
        // Mint entire supply to the campaign contract.
        // Campaign.invest() will transfer from this pool to investors.
        _mint(campaign_, TOTAL_SUPPLY);
    }

    // ─────────────────────────────────────────────────────────────
    // OWNER-ONLY FUNCTIONS (called by CampaignV2)
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Update an investor's reputation score after a
     * milestone vote resolution.
     *
     * Called by CampaignV2.resolveVote() for each investor who
     * participated in the vote.
     *
     * The new score is a weighted average of the existing score
     * and the performance on this vote:
     *   newScore = (oldScore * existingVotes + performanceScore)
     *              / (existingVotes + 1)
     *
     * This means early votes have more influence on reputation
     * when there's little history, but the score stabilizes
     * as participation count grows. Exactly how ELO-style
     * rating systems work.
     *
     * @param investor          Address of the voter
     * @param performanceScore  Brier-derived score for this vote,
     *                          scaled 0-10000. Higher = more accurate.
     *                          (Note: we invert the Brier score here —
     *                          low Brier error = high performance score)
     */
    function updateReputation(
        address investor,
        uint256 performanceScore
    ) external onlyOwner {
        require(
            performanceScore <= 10_000,
            "CampaignTokenV2: performance score out of range"
        );

        uint256 oldScore = reputationScore[investor];
        uint256 count = voteParticipationCount[investor];

        uint256 newScore;

        if (count == 0) {
            // First vote — set score directly, don't average
            // with the neutral 0 starting value
            newScore = performanceScore;
        } else {
            // Weighted average: existing history carries more
            // weight as participation count grows
            newScore = (oldScore * count + performanceScore) / (count + 1);
        }

        // Cap at 10000
        if (newScore > 10_000) newScore = 10_000;

        reputationScore[investor] = newScore;
        voteParticipationCount[investor] += 1;

        emit ReputationUpdated(investor, oldScore, newScore);
    }

    /**
     * @notice Burn tokens from an investor during refund.
     *
     * When an investor claims a refund, their tokens are burned.
     * This prevents double-claiming and keeps the token supply
     * accurate as an accounting mechanism.
     *
     * Only callable by the Campaign contract (owner).
     *
     * @param from    The investor address to burn from
     * @param amount  Amount of tokens to burn (in wei, 18 decimals)
     */
    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }

    // ─────────────────────────────────────────────────────────────
    // VIEW FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Get an investor's reputation score.
     * Returns 5000 (neutral) for addresses with no history,
     * so new investors aren't penalized for being new.
     *
     * @param investor  Address to check
     * @return score    Reputation score 0-10000
     */
    function getReputationScore(
        address investor
    ) external view returns (uint256 score) {
        if (voteParticipationCount[investor] == 0) {
            return 5_000; // Neutral starting reputation
        }
        return reputationScore[investor];
    }
}