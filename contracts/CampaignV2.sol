// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./CampaignTokenV2.sol";
import "./BrierMath.sol";

/**
 * @title CampaignV2
 * @notice Core campaign contract for LaunchVault V2.
 *
 * Lifecycle per campaign:
 *   1. Founder deploys via CampaignFactoryV2, staking ETH.
 *   2. Investors call invest() — receive governance tokens.
 *   3. For each milestone:
 *        a. Oracle submits AI verification score.
 *        b. Founder calls startMilestoneVote().
 *        c. Investors commit hashed votes (commit phase).
 *        d. Investors reveal actual probabilities (reveal phase).
 *        e. Anyone calls resolveVote() after deadline.
 *           → funds released or marked refundable.
 *   4. Investors call claimRefund() if vote failed.
 *   5. Founder calls releaseMilestone() if vote passed.
 *
 * Game Theory Properties:
 *   - Founder stake: costly signal separating genuine founders
 *     from fraudsters (Spence signaling theory).
 *   - Commit-reveal: prevents herding / vote copying.
 *   - Brier scoring: proper scoring rule making truthful
 *     probability reporting the dominant strategy.
 *   - Participation rewards: solves free-rider problem by
 *     penalizing abstention.
 */
contract CampaignV2 is ReentrancyGuard {

    // ─────────────────────────────────────────────────────────────
    // CONSTANTS
    // ─────────────────────────────────────────────────────────────

    /// @notice Voting commit phase duration in seconds (4 days).
    uint256 public constant COMMIT_DURATION = 4 days;

    /// @notice Voting reveal phase duration in seconds (3 days).
    uint256 public constant REVEAL_DURATION = 3 days;

    /// @notice Total voting window = commit + reveal = 7 days.
    uint256 public constant TOTAL_VOTE_DURATION =
        COMMIT_DURATION + REVEAL_DURATION;

    /**
     * @notice Quorum: minimum % of tokens that must participate
     * for a vote to be valid. Scaled by 100 (so 2000 = 20%).
     * If participation is below this, vote is inconclusive
     * and a new vote can be started.
     */
    uint256 public constant QUORUM_PERCENT = 2000; // 20%

    /**
     * @notice Pass threshold: % of participating tokens that
     * must vote YES for the milestone to pass.
     * Scaled by 100 (5100 = 51%).
     */
    uint256 public constant PASS_THRESHOLD = 5100; // 51%

    /**
     * @notice Non-voter penalty: % of refund withheld from
     * investors who did not vote.
     * Scaled by 100 (500 = 5%).
     * This 5% goes to the participation reward pool.
     */
    uint256 public constant NONVOTER_PENALTY = 500; // 5%

    /**
     * @notice Minimum founder stake as % of funding goal.
     * Scaled by 100 (1000 = 10%).
     * Founder must send at least 10% of goal as stake.
     */
    uint256 public constant MIN_STAKE_PERCENT = 1000; // 10%

    // ─────────────────────────────────────────────────────────────
    // ENUMS
    // ─────────────────────────────────────────────────────────────

    enum CampaignState {
        Active,       // Accepting investments
        Funded,       // Goal reached, awaiting milestones
        Completed,    // All milestones passed, all funds released
        Cancelled     // Cancelled by founder or expired
    }

    enum MilestoneState {
        Pending,      // Not yet started
        VotingOpen,   // Commit phase active
        RevealOpen,   // Reveal phase active
        Passed,       // Vote passed, funds released
        Failed,       // Vote failed, funds refundable
        Inconclusive  // Quorum not met, can restart
    }

    // ─────────────────────────────────────────────────────────────
    // STRUCTS
    // ─────────────────────────────────────────────────────────────

    struct Milestone {
        string description;

        /// @dev Percentage of total raised to release on pass.
        /// Scaled by 100 (3000 = 30%). All milestones must sum to 10000.
        uint256 fundingBps;

        MilestoneState state;

        /// @dev Written by oracle before voting opens.
        /// Scaled 0–10000. 0 means not yet submitted.
        uint256 agentScore;
        bool    agentScoreSubmitted;

        /// @dev Timestamps for commit and reveal phases.
        uint256 commitDeadline;
        uint256 revealDeadline;

        /// @dev Commit phase: stores keccak256(probability + salt) per voter.
        mapping(address => bytes32) commitHash;
        mapping(address => bool)    hasCommitted;

        /// @dev Reveal phase: stores revealed probability per voter.
        mapping(address => uint256) revealedProbability;
        mapping(address => bool)    hasRevealed;

        /// @dev Aggregated vote state.
        uint256 totalWeightedProbability; // sum of (probability * tokenBalance)
        uint256 totalVotingWeight;        // sum of tokenBalance of all voters
        uint256 participantCount;

        /// @dev ETH amount allocated to this milestone (set at funding time).
        uint256 ethAllocation;

        /// @dev Whether the allocated ETH has been released to founder.
        bool fundsReleased;

        /// @dev Ordered list of addresses that completed revealVote().
        /// Needed for iteration in resolveVote() — mappings cannot be iterated.
        address[] revealedVoters;
    }

    // ─────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────

    /// @notice The founder who created this campaign.
    address public immutable founder;

    /// @notice Address authorized to submit AI agent scores.
    /// Set at deployment by the factory. Only this address
    /// can call submitAgentScore().
    address public immutable oracle;

    /// @notice The governance token contract for this campaign.
    CampaignTokenV2 public immutable token;

    /// @notice Campaign metadata.
    string  public title;
    string  public description;

    /// @notice Funding goal in wei.
    uint256 public immutable goal;

    /// @notice Unix timestamp after which no new investments accepted.
    uint256 public immutable deadline;

    /// @notice Total ETH invested so far.
    uint256 public totalRaised;

    /// @notice ETH staked by founder at deployment.
    /// Returned or slashed based on milestone outcomes.
    uint256 public founderStake;

    /// @notice Current campaign state.
    CampaignState public campaignState;

    /// @notice The milestone array.
    /// We use a fixed-size approach: milestones are pushed in
    /// constructor and never added afterward.
    Milestone[] public milestones;

    /// @notice Index of the currently active milestone.
    /// Only valid when campaignState == Funded.
    uint256 public currentMilestoneIndex;

    /// @notice Track which investors have claimed refunds per milestone.
    /// milestoneIndex => investor => claimed
    mapping(uint256 => mapping(address => bool)) public refundClaimed;

    /// @notice Track how much ETH each investor put in.
    /// Needed for refund calculation.
    mapping(address => uint256) public investedAmount;

    /// @notice List of all investor addresses for iteration.
    address[] public investors;
    mapping(address => bool) public isInvestor;

    // ── Resolution accounting ──────────────────────────────────────

    /// @notice Non-voter penalty deducted from each investor's future refund.
    /// milestoneIndex => investor => penalty (wei)
    mapping(uint256 => mapping(address => uint256)) public penaltyDeducted;

    /// @notice Participation reward earned by each voter from the penalty pool.
    /// milestoneIndex => voter => reward (wei)
    mapping(uint256 => mapping(address => uint256)) public participationReward;

    /// @notice Founder-stake share slashed to each investor on a failed milestone.
    /// milestoneIndex => investor => slash share (wei)
    mapping(uint256 => mapping(address => uint256)) public stakeSlashShare;

    /// @notice Timestamp after which founder stake can be released on a
    /// suspicious milestone (14-day collusion-challenge window).
    /// 0 means no hold. milestoneIndex => unix timestamp
    mapping(uint256 => uint256) public stakeHeldUntil;

    // ─────────────────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────────────────

    event Invested(
        address indexed investor,
        uint256 ethAmount,
        uint256 tokensReceived
    );

    event GoalReached(uint256 totalRaised);

    event AgentScoreSubmitted(
        uint256 indexed milestoneIndex,
        uint256 score
    );

    event VoteCommitted(
        uint256 indexed milestoneIndex,
        address indexed voter
    );

    event VoteRevealed(
        uint256 indexed milestoneIndex,
        address indexed voter,
        uint256 probability
    );

    event MilestoneVoteStarted(
        uint256 indexed milestoneIndex,
        uint256 commitDeadline,
        uint256 revealDeadline
    );

    event MilestonePassed(
        uint256 indexed milestoneIndex,
        uint256 ethReleased
    );

    event MilestoneFailed(
        uint256 indexed milestoneIndex
    );

    event RefundClaimed(
        address indexed investor,
        uint256 indexed milestoneIndex,
        uint256 ethAmount
    );

    event CampaignCancelled();

    event FounderStakeSlashed(uint256 amount);

    event FounderStakeReturned(uint256 amount);

    // ─────────────────────────────────────────────────────────────
    // MODIFIERS
    // ─────────────────────────────────────────────────────────────

    modifier onlyFounder() {
        require(
            msg.sender == founder,
            "CampaignV2: caller is not the founder"
        );
        _;
    }

    modifier onlyOracle() {
        require(
            msg.sender == oracle,
            "CampaignV2: caller is not the oracle"
        );
        _;
    }

    modifier onlyState(CampaignState expected) {
        require(
            campaignState == expected,
            "CampaignV2: invalid campaign state"
        );
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────

    /**
     * @param _founder              Address of the campaign creator.
     * @param _oracle               Address authorized to submit AI scores.
     * @param _title                Campaign title.
     * @param _description          Campaign description.
     * @param _goal                 Funding goal in wei.
     * @param _deadline             Unix timestamp for investment deadline.
     * @param _tokenName            Name for the governance token.
     * @param _tokenSymbol          Symbol for the governance token.
     * @param _milestoneDescriptions Array of milestone descriptions.
     * @param _milestoneBps          Array of funding basis points per milestone.
     *                               Each value is 0–10000, must sum to 10000.
     *
     * @dev The founder must send ETH with this call as their stake.
     *      Minimum stake = MIN_STAKE_PERCENT% of goal.
     *      This stake is held in the contract until milestone resolution.
     */
    constructor(
        address _founder,
        address _oracle,
        string memory _title,
        string memory _description,
        uint256 _goal,
        uint256 _deadline,
        string memory _tokenName,
        string memory _tokenSymbol,
        string[] memory _milestoneDescriptions,
        uint256[] memory _milestoneBps
    ) payable {
        // ── Input validation ───────────────────────────────────────

        require(_founder != address(0),  "CampaignV2: invalid founder");
        require(_oracle  != address(0),  "CampaignV2: invalid oracle");
        require(_goal    > 0,            "CampaignV2: goal must be > 0");
        require(
            _deadline > block.timestamp,
            "CampaignV2: deadline must be in future"
        );
        require(
            _milestoneDescriptions.length > 0,
            "CampaignV2: need at least one milestone"
        );
        require(
            _milestoneDescriptions.length == _milestoneBps.length,
            "CampaignV2: milestone arrays length mismatch"
        );

        // ── Validate milestone bps sum to 10000 ────────────────────

        uint256 totalBps = 0;
        for (uint256 i = 0; i < _milestoneBps.length; i++) {
            require(
                _milestoneBps[i] > 0,
                "CampaignV2: each milestone must have > 0 bps"
            );
            totalBps += _milestoneBps[i];
        }
        require(
            totalBps == 10_000,
            "CampaignV2: milestone bps must sum to 10000"
        );

        // ── Validate founder stake ─────────────────────────────────

        uint256 minStake = (_goal * MIN_STAKE_PERCENT) / 10_000;
        require(
            msg.value >= minStake,
            "CampaignV2: insufficient founder stake"
        );

        // ── Set immutables ─────────────────────────────────────────

        founder     = _founder;
        oracle      = _oracle;
        title       = _title;
        description = _description;
        goal        = _goal;
        deadline    = _deadline;
        founderStake = msg.value;
        campaignState = CampaignState.Active;

        // ── Deploy governance token ────────────────────────────────
        // Token is deployed here. address(this) is the owner
        // because this contract needs to call burn() and
        // updateReputation() on it later.

        token = new CampaignTokenV2(
            _tokenName,
            _tokenSymbol,
            address(this)
        );

        // ── Initialize milestones ──────────────────────────────────
        // We push structs to storage. Mappings inside structs
        // are initialized to zero automatically by Solidity.

        for (uint256 i = 0; i < _milestoneDescriptions.length; i++) {
            // Push an empty milestone then set its fields.
            // We cannot push a struct with mapping fields directly.
            milestones.push();
            Milestone storage m = milestones[i];
            m.description = _milestoneDescriptions[i];
            m.fundingBps  = _milestoneBps[i];
            m.state       = MilestoneState.Pending;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // INVEST
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Invest ETH into the campaign and receive governance tokens.
     *
     * Token allocation:
     *   tokens = (msg.value / goal) * TOTAL_SUPPLY
     *
     * If this investment causes totalRaised >= goal:
     *   - campaignState transitions to Funded
     *   - ETH allocations are calculated for each milestone
     *
     * @dev Uses nonReentrant because we transfer tokens
     *      and update state.
     */
    function invest() external payable nonReentrant onlyState(CampaignState.Active) {
        require(
            block.timestamp <= deadline,
            "CampaignV2: investment deadline passed"
        );
        require(msg.value > 0, "CampaignV2: investment must be > 0");

        // Calculate token allocation proportional to investment.
        // TOTAL_SUPPLY = 10_000 * 1e18
        // tokens = (msg.value * TOTAL_SUPPLY) / goal
        // Multiply first to preserve precision before dividing.
        uint256 tokensToMint = (msg.value * token.TOTAL_SUPPLY()) / goal;
        require(
            tokensToMint > 0,
            "CampaignV2: investment too small for token allocation"
        );
        require(
            token.balanceOf(address(this)) >= tokensToMint,
            "CampaignV2: not enough tokens remaining"
        );

        // Record investment
        totalRaised += msg.value;
        investedAmount[msg.sender] += msg.value;

        // Track investor address for iteration
        if (!isInvestor[msg.sender]) {
            isInvestor[msg.sender] = true;
            investors.push(msg.sender);
        }

        // Transfer tokens from this contract to investor
        token.transfer(msg.sender, tokensToMint);

        emit Invested(msg.sender, msg.value, tokensToMint);

        // Check if goal is now reached
        if (totalRaised >= goal) {
            _transitionToFunded();
        }
    }

    /**
     * @dev Transitions campaign to Funded state and calculates
     * ETH allocation for each milestone based on totalRaised.
     *
     * Called exactly once when totalRaised >= goal.
     */
    function _transitionToFunded() internal {
        campaignState = CampaignState.Funded;

        for (uint256 i = 0; i < milestones.length; i++) {
            // ethAllocation = (totalRaised * fundingBps) / 10_000
            milestones[i].ethAllocation =
                (totalRaised * milestones[i].fundingBps) / 10_000;
        }

        emit GoalReached(totalRaised);
    }

    // ─────────────────────────────────────────────────────────────
    // ORACLE
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Submit the AI agent's verification score for a milestone.
     *
     * Called by the oracle (off-chain AI agent pipeline) before
     * the founder starts voting on that milestone.
     *
     * @param milestoneIndex  Index into milestones array
     * @param score           AI confidence score 0–10000
     *                        10000 = agent is certain milestone was achieved
     *                        0     = agent is certain it was not achieved
     */
    function submitAgentScore(
        uint256 milestoneIndex,
        uint256 score
    ) external onlyOracle {
        require(
            milestoneIndex < milestones.length,
            "CampaignV2: invalid milestone index"
        );
        require(
            score <= BrierMath.SCALE,
            "CampaignV2: score out of range"
        );

        Milestone storage m = milestones[milestoneIndex];

        require(
            m.state == MilestoneState.Pending,
            "CampaignV2: score already submitted or voting started"
        );
        require(
            !m.agentScoreSubmitted,
            "CampaignV2: agent score already submitted"
        );

        m.agentScore = score;
        m.agentScoreSubmitted = true;

        emit AgentScoreSubmitted(milestoneIndex, score);
    }

    // ─────────────────────────────────────────────────────────────
    // VIEW FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /// @notice Total number of milestones.
    function milestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    /// @notice Total number of investors.
    function investorCount() external view returns (uint256) {
        return investors.length;
    }

    /**
     * @notice Get milestone info without mapping fields.
     * Solidity cannot return structs with mappings, so we
     * return only the scalar fields.
     */
    function getMilestone(uint256 index) external view returns (
        string memory desc,
        uint256 fundingBps,
        MilestoneState state,
        uint256 agentScore,
        bool    agentScoreSubmitted,
        uint256 commitDeadline,
        uint256 revealDeadline,
        uint256 ethAllocation,
        bool    fundsReleased,
        uint256 participantCount
    ) {
        require(index < milestones.length, "CampaignV2: invalid index");
        Milestone storage m = milestones[index];
        return (
            m.description,
            m.fundingBps,
            m.state,
            m.agentScore,
            m.agentScoreSubmitted,
            m.commitDeadline,
            m.revealDeadline,
            m.ethAllocation,
            m.fundsReleased,
            m.participantCount
        );
    }

    /**
     * @notice Get an investor's commit status for a milestone.
     */
    function getCommitStatus(
        uint256 milestoneIndex,
        address investor
    ) external view returns (bool committed, bool revealed) {
        require(milestoneIndex < milestones.length, "CampaignV2: invalid index");
        Milestone storage m = milestones[milestoneIndex];
        return (m.hasCommitted[investor], m.hasRevealed[investor]);
    }

    /**
     * @notice Cancel the campaign.
     * Only callable by founder while campaign is Active.
     * Once Funded, cannot be cancelled (investors have rights).
     */
    function cancelCampaign()
        external
        onlyFounder
        onlyState(CampaignState.Active)
    {
        campaignState = CampaignState.Cancelled;
        emit CampaignCancelled();
    }
    // ─────────────────────────────────────────────────────────────
    // VOTING — PHASE 0: START
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Founder starts the voting process for the current milestone.
     *
     * Requirements:
     *   - Campaign must be Funded
     *   - Current milestone must be Pending
     *   - Agent score must already be submitted
     *   - Caller must be the founder
     *
     * Sets commit deadline and reveal deadline.
     * Transitions milestone state to VotingOpen.
     */
    function startMilestoneVote()
        external
        onlyFounder
        onlyState(CampaignState.Funded)
    {
        Milestone storage m = milestones[currentMilestoneIndex];

        require(
            m.state == MilestoneState.Pending,
            "CampaignV2: milestone not in Pending state"
        );
        require(
            m.agentScoreSubmitted,
            "CampaignV2: agent score not submitted yet"
        );

        m.commitDeadline = block.timestamp + COMMIT_DURATION;
        m.revealDeadline = m.commitDeadline + REVEAL_DURATION;
        m.state = MilestoneState.VotingOpen;

        emit MilestoneVoteStarted(
            currentMilestoneIndex,
            m.commitDeadline,
            m.revealDeadline
        );
    }

    // ─────────────────────────────────────────────────────────────
    // VOTING — PHASE 1: COMMIT
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Submit a hashed vote for the current milestone.
     *
     * The hash must be: keccak256(abi.encodePacked(probability, salt))
     * where probability is 0–10000 and salt is any bytes32.
     *
     * The investor must hold tokens to vote.
     * The investor can only commit once per milestone.
     * Must be called before commitDeadline.
     *
     * @param milestoneIndex  Must equal currentMilestoneIndex
     * @param hash            keccak256(abi.encodePacked(probability, salt))
     */
    function commitVote(
        uint256 milestoneIndex,
        bytes32 hash
    ) external {
        require(
            milestoneIndex == currentMilestoneIndex,
            "CampaignV2: not the active milestone"
        );

        Milestone storage m = milestones[milestoneIndex];

        require(
            m.state == MilestoneState.VotingOpen,
            "CampaignV2: commit phase not open"
        );
        require(
            block.timestamp <= m.commitDeadline,
            "CampaignV2: commit phase ended"
        );
        require(
            token.balanceOf(msg.sender) > 0,
            "CampaignV2: must hold tokens to vote"
        );
        require(
            !m.hasCommitted[msg.sender],
            "CampaignV2: already committed"
        );
        require(hash != bytes32(0), "CampaignV2: hash cannot be zero");

        m.commitHash[msg.sender] = hash;
        m.hasCommitted[msg.sender] = true;

        emit VoteCommitted(milestoneIndex, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────
    // VOTING — PHASE 2: REVEAL
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Reveal your vote for the current milestone.
     *
     * The contract reconstructs the hash from the provided
     * probability and salt, and verifies it matches what was
     * committed. This proves the voter is not changing their
     * vote after seeing others' results.
     *
     * Must be called after commitDeadline and before revealDeadline.
     * Investor must have committed in phase 1.
     *
     * @param milestoneIndex  Must equal currentMilestoneIndex
     * @param probability     The voter's confidence 0–10000
     *                        10000 = certain milestone was achieved
     *                        0     = certain it was not
     * @param salt            The same salt used when committing
     */
    function revealVote(
        uint256 milestoneIndex,
        uint256 probability,
        bytes32 salt
    ) external {
        require(
            milestoneIndex == currentMilestoneIndex,
            "CampaignV2: not the active milestone"
        );

        Milestone storage m = milestones[milestoneIndex];

        require(
            m.state == MilestoneState.VotingOpen ||
                m.state == MilestoneState.RevealOpen,
            "CampaignV2: not in voting phase"
        );
        require(
            block.timestamp > m.commitDeadline,
            "CampaignV2: commit phase still open"
        );
        require(
            block.timestamp <= m.revealDeadline,
            "CampaignV2: reveal phase ended"
        );
        require(
            m.hasCommitted[msg.sender],
            "CampaignV2: must commit before revealing"
        );
        require(
            !m.hasRevealed[msg.sender],
            "CampaignV2: already revealed"
        );
        require(
            probability <= BrierMath.SCALE,
            "CampaignV2: probability out of range"
        );

        // Verify the revealed values match the commit hash
        bytes32 expectedHash = keccak256(
            abi.encodePacked(probability, salt)
        );
        require(
            expectedHash == m.commitHash[msg.sender],
            "CampaignV2: hash mismatch - probability or salt incorrect"
        );

        // Record the reveal
        m.hasRevealed[msg.sender] = true;
        m.revealedProbability[msg.sender] = probability;

        // Add to weighted totals
        // Weight = token balance at reveal time
        // This is intentional: token balance is public info and
        // doesn't change during voting (no minting/burning mid-vote)
        uint256 weight = token.balanceOf(msg.sender);
        m.totalWeightedProbability += probability * weight;
        m.totalVotingWeight        += weight;
        m.participantCount         += 1;

        // Record voter for iteration in resolveVote()
        m.revealedVoters.push(msg.sender);

        // Transition to RevealOpen state if not already
        // (first reveal triggers the state change)
        if (m.state == MilestoneState.VotingOpen) {
            m.state = MilestoneState.RevealOpen;
        }

        emit VoteRevealed(milestoneIndex, msg.sender, probability);
    }

    // ─────────────────────────────────────────────────────────────
    // VOTING — PHASE 3: RESOLVE
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Resolve the vote for the current milestone after reveal deadline.
     *
     * Anyone can call this once block.timestamp > revealDeadline.
     * Performs, in order:
     *   1. Quorum check  → Inconclusive if < 20 % of supply participated
     *   2. Weighted-average probability → determine pass/fail outcome
     *   3. Collusion detection → hold stake 14 days if suspicious
     *   4. Milestone state update (Passed / Failed)
     *   5. Reputation update for every revealed voter
     *   6. Non-voter penalty pool calculation
     *   7. Participation reward distribution (from penalty pool)
     *   8. Founder stake slash on non-suspicious failure
     *   9. Advance currentMilestoneIndex / mark campaign Completed
     *
     * @param milestoneIndex  Must equal currentMilestoneIndex.
     */
    function resolveVote(uint256 milestoneIndex) external {
        require(
            milestoneIndex == currentMilestoneIndex,
            "CampaignV2: not the active milestone"
        );

        Milestone storage m = milestones[milestoneIndex];

        require(
            m.state == MilestoneState.RevealOpen,
            "CampaignV2: milestone not in RevealOpen state"
        );
        require(
            block.timestamp > m.revealDeadline,
            "CampaignV2: reveal phase not ended"
        );

        // ── Step 1 — Quorum check ──────────────────────────────────
        // participationRate = (totalVotingWeight * SCALE) / totalSupply
        // SCALE = 10_000, so 2000 = 20 %
        uint256 totalSupply      = token.TOTAL_SUPPLY();
        uint256 participationRate = (m.totalVotingWeight * BrierMath.SCALE) / totalSupply;

        if (participationRate < QUORUM_PERCENT) {
            m.state = MilestoneState.Inconclusive;
            emit MilestoneFailed(milestoneIndex);
            return;
        }

        // ── Step 2 — Weighted average probability ─────────────────
        uint256 avgProbability = m.totalWeightedProbability / m.totalVotingWeight;

        // ── Step 3 — Determine outcome ────────────────────────────
        // outcome: BrierMath.SCALE (10_000) = passed, 0 = failed
        uint256 outcome = avgProbability >= PASS_THRESHOLD ? BrierMath.SCALE : 0;

        // ── Step 4 — Collusion detection ──────────────────────────
        // Suspicious when oracle is highly confident (score > 7500 or < 2500)
        // AND the vote outcome contradicts the oracle's implied verdict.
        uint256 agentOutcome = m.agentScore >= 5_000 ? BrierMath.SCALE : 0;
        bool suspicious = (outcome != agentOutcome) &&
                          (m.agentScore > 7_500 || m.agentScore < 2_500);
        if (suspicious) {
            // Hold founder stake for 14-day challenge window
            stakeHeldUntil[milestoneIndex] = block.timestamp + 14 days;
        }

        // ── Step 5 — Update milestone state ───────────────────────
        m.state = (outcome == BrierMath.SCALE)
            ? MilestoneState.Passed
            : MilestoneState.Failed;

        // ── Step 6 — Reputation updates + cache scores ────────────
        // Cache both performance and reputation scores to avoid
        // recomputing in the reward distribution pass below.
        uint256 numVoters = m.revealedVoters.length;
        uint256[] memory perfScores = new uint256[](numVoters);
        uint256[] memory repScores  = new uint256[](numVoters);

        for (uint256 i = 0; i < numVoters; i++) {
            address voter = m.revealedVoters[i];
            uint256 bs   = BrierMath.brierScore(m.revealedProbability[voter], outcome);
            uint256 perf = BrierMath.toPerformanceScore(bs);
            perfScores[i] = perf;
            token.updateReputation(voter, perf);
            // Read AFTER update so reward uses the freshest reputation
            repScores[i] = token.getReputationScore(voter);
        }

        // ── Step 7 — Non-voter penalty pool ───────────────────────
        // Penalty = 5 % of each non-voter's total invested amount.
        // Recorded per-investor for deduction in claimRefund().
        // NOT transferred now — deducted lazily at claim time.
        uint256 nonVoterPenaltyPool = 0;
        for (uint256 i = 0; i < investors.length; i++) {
            address inv = investors[i];
            if (!m.hasRevealed[inv]) {
                uint256 penalty =
                    (investedAmount[inv] * NONVOTER_PENALTY) / BrierMath.SCALE;
                nonVoterPenaltyPool              += penalty;
                penaltyDeducted[milestoneIndex][inv] = penalty;
            }
        }

        // ── Step 8 — Participation reward distribution ────────────
        // Weight for voter i = (perfScore_i * repScore_i) / SCALE
        // Share  for voter i = (weight_i / totalWeight) * pool
        uint256 totalRewardWeight = 0;
        for (uint256 i = 0; i < numVoters; i++) {
            totalRewardWeight += (perfScores[i] * repScores[i]) / BrierMath.SCALE;
        }

        for (uint256 i = 0; i < numVoters; i++) {
            address voter = m.revealedVoters[i];
            participationReward[milestoneIndex][voter] =
                BrierMath.calculateRewardShare(
                    perfScores[i],
                    repScores[i],
                    nonVoterPenaltyPool,
                    totalRewardWeight
                );
        }

        // ── Step 9 — Founder stake handling ───────────────────────
        if (outcome == 0) {
            if (!suspicious && founderStake > 0) {
                // Slash entire remaining stake proportionally to token holdings.
                // Stored per-investor for collection via claimRefund().
                uint256 stakeToSlash = founderStake;
                founderStake = 0;
                for (uint256 i = 0; i < investors.length; i++) {
                    address inv = investors[i];
                    stakeSlashShare[milestoneIndex][inv] =
                        (token.balanceOf(inv) * stakeToSlash) / totalSupply;
                }
                emit FounderStakeSlashed(stakeToSlash);
            }
            // If suspicious, founderStake is held until stakeHeldUntil[milestoneIndex]
            emit MilestoneFailed(milestoneIndex);
        } else {
            emit MilestonePassed(milestoneIndex, m.ethAllocation);
            currentMilestoneIndex += 1;
            if (currentMilestoneIndex >= milestones.length) {
                campaignState = CampaignState.Completed;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // RELEASE
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Transfer ETH to the founder for a milestone that passed.
     *
     * Only the founder may call this. The milestone must be in the
     * Passed state and not yet have had its funds released.
     *
     * If the milestone was flagged as suspicious during resolveVote()
     * (stakeHeldUntil > 0), the 14-day challenge window must have
     * elapsed before funds can move.
     *
     * When ALL milestone ETH allocations have been released AND the
     * campaign is in the Completed state, the founder stake is also
     * returned (it was never slashed because all milestones passed).
     *
     * @param milestoneIndex  Index of the passed milestone to release.
     */
    function releaseMilestone(uint256 milestoneIndex)
        external
        nonReentrant
        onlyFounder
    {
        require(
            milestoneIndex < milestones.length,
            "CampaignV2: invalid milestone index"
        );

        Milestone storage m = milestones[milestoneIndex];

        require(
            m.state == MilestoneState.Passed,
            "CampaignV2: milestone not in Passed state"
        );
        require(
            !m.fundsReleased,
            "CampaignV2: funds already released"
        );

        // If a collusion-suspicion hold was placed, the 14-day
        // challenge period must have elapsed before release.
        if (stakeHeldUntil[milestoneIndex] > 0) {
            require(
                block.timestamp > stakeHeldUntil[milestoneIndex],
                "CampaignV2: challenge period not elapsed"
            );
        }

        // ── Effects ────────────────────────────────────────────
        m.fundsReleased = true;
        uint256 amount = m.ethAllocation;

        // Check whether this is the last milestone to be released.
        // Only relevant when the campaign is Completed (all passed).
        uint256 stakeToReturn = 0;
        if (campaignState == CampaignState.Completed && founderStake > 0) {
            bool allReleased = true;
            for (uint256 i = 0; i < milestones.length; i++) {
                if (!milestones[i].fundsReleased) {
                    allReleased = false;
                    break;
                }
            }
            if (allReleased) {
                stakeToReturn = founderStake;
                founderStake  = 0;
            }
        }

        // ── Interactions ───────────────────────────────────────
        (bool success, ) = payable(founder).call{value: amount}("");
        require(success, "CampaignV2: ETH transfer failed");

        emit MilestonePassed(milestoneIndex, amount);

        if (stakeToReturn > 0) {
            (bool stakeOk, ) = payable(founder).call{value: stakeToReturn}("");
            require(stakeOk, "CampaignV2: stake return failed");
            emit FounderStakeReturned(stakeToReturn);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // REFUND
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Claim an ETH refund for a Failed or Inconclusive milestone.
     *
     * Net refund formula:
     *   gross     = (tokenBalance × ethAllocation) / TOTAL_SUPPLY
     *   net       = gross - penaltyDeducted
     *                     + participationReward
     *                     + stakeSlashShare
     *               (floored at 0 to prevent underflow)
     *
     * Tokens are only burned when every milestone is in a terminal
     * state (Passed / Failed / Inconclusive). While any milestone is
     * still Pending / VotingOpen / RevealOpen, tokens are preserved
     * so investors can participate in future governance votes.
     *
     * @param milestoneIndex  Index of the Failed / Inconclusive milestone.
     */
    function claimRefund(uint256 milestoneIndex) external nonReentrant {
        require(
            milestoneIndex < milestones.length,
            "CampaignV2: invalid milestone index"
        );

        Milestone storage m = milestones[milestoneIndex];

        require(
            m.state == MilestoneState.Failed ||
                m.state == MilestoneState.Inconclusive,
            "CampaignV2: milestone not refundable"
        );
        require(
            !refundClaimed[milestoneIndex][msg.sender],
            "CampaignV2: refund already claimed"
        );
        uint256 balance = token.balanceOf(msg.sender);
        require(balance > 0, "CampaignV2: no tokens held");

        // ── Calculate net refund ────────────────────────────────
        uint256 grossRefund = (balance * m.ethAllocation) / token.TOTAL_SUPPLY();
        uint256 penalty     = penaltyDeducted[milestoneIndex][msg.sender];
        uint256 reward      = participationReward[milestoneIndex][msg.sender];
        uint256 slashShare  = stakeSlashShare[milestoneIndex][msg.sender];

        uint256 credit    = grossRefund + reward + slashShare;
        uint256 netRefund = credit > penalty ? credit - penalty : 0;

        // ── Effects ────────────────────────────────────────────
        refundClaimed[milestoneIndex][msg.sender] = true;

        // Capture burn decision before any external call (CEI).
        bool shouldBurn = _allMilestonesTerminal();

        // ── Interactions ───────────────────────────────────────
        if (shouldBurn) {
            token.burn(msg.sender, balance);
        }

        if (netRefund > 0) {
            (bool success, ) = payable(msg.sender).call{value: netRefund}("");
            require(success, "CampaignV2: refund transfer failed");
        }

        emit RefundClaimed(msg.sender, milestoneIndex, netRefund);
    }

    // ─────────────────────────────────────────────────────────────
    // INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────────

    /**
     * @dev Returns true when no milestone is in an active or
     * upcoming voting state (Pending / VotingOpen / RevealOpen).
     *
     * Used by claimRefund() to decide whether to burn tokens:
     * tokens must be preserved while future votes may still occur.
     */
    function _allMilestonesTerminal() internal view returns (bool) {
        for (uint256 i = 0; i < milestones.length; i++) {
            MilestoneState s = milestones[i].state;
            if (
                s == MilestoneState.Pending    ||
                s == MilestoneState.VotingOpen ||
                s == MilestoneState.RevealOpen
            ) {
                return false;
            }
        }
        return true;
    }

    // ─────────────────────────────────────────────────────────────
    // VIEW HELPERS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Number of investors who revealed for a given milestone.
     * Useful for tests and off-chain UIs.
     */
    function revealedVoterCount(uint256 index) external view returns (uint256) {
        require(index < milestones.length, "CampaignV2: invalid index");
        return milestones[index].revealedVoters.length;
    }
}
