// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./CampaignV2.sol";

/**
 * @title CampaignFactoryV2
 * @notice Permissionless factory for deploying CampaignV2 instances.
 *
 * A single oracle address is set at construction time and is shared
 * across every campaign this factory creates. The entity that deploys
 * the factory is responsible for supplying a trustworthy oracle address.
 *
 * Any EOA or contract can call createCampaign() and become the founder
 * of a new campaign. The caller must attach enough ETH to satisfy
 * CampaignV2's minimum founder-stake requirement (10 % of goal).
 * That ETH is forwarded directly to the newly deployed CampaignV2
 * constructor — the factory never holds funds.
 */
contract CampaignFactoryV2 {

    // ─────────────────────────────────────────────────────────────
    // STRUCTS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Lightweight registry record stored for each campaign.
     * Contains only the fields needed for off-chain discovery;
     * all campaign logic lives in the CampaignV2 contract itself.
     */
    struct CampaignInfo {
        address campaignAddress;  // deployed CampaignV2 contract
        address founder;          // msg.sender who called createCampaign
        string  title;            // human-readable name
        uint256 goal;             // funding goal in wei
        uint256 createdAt;        // block.timestamp of deployment
    }

    // ─────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice The AI-agent oracle address shared by all campaigns
     * created through this factory. Immutable after deployment.
     */
    address public immutable oracle;

    /**
     * @notice Append-only registry of every campaign deployed through
     * this factory, in creation order.
     */
    CampaignInfo[] public campaigns;

    // ─────────────────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Emitted when a new CampaignV2 is deployed via this factory.
     * @param campaignAddress  Address of the newly deployed campaign.
     * @param founder          Address that will own the campaign.
     * @param title            Human-readable campaign title.
     * @param goal             Funding goal in wei.
     */
    event CampaignCreated(
        address indexed campaignAddress,
        address indexed founder,
        string          title,
        uint256         goal
    );

    // ─────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────

    /**
     * @param _oracle  Address authorised to submit AI agent scores
     *                 for every campaign created through this factory.
     *                 Cannot be the zero address.
     */
    constructor(address _oracle) {
        require(
            _oracle != address(0),
            "CampaignFactoryV2: oracle cannot be zero address"
        );
        oracle = _oracle;
    }

    // ─────────────────────────────────────────────────────────────
    // EXTERNAL FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Deploy a new CampaignV2 and register it in this factory.
     *
     * The caller (msg.sender) becomes the campaign founder.
     * msg.value is forwarded in full to the CampaignV2 constructor
     * as the founder stake — the factory never retains any ETH.
     *
     * All parameter validation (stake ≥ 10 % of goal, deadline in
     * the future, bps sum to 10 000, etc.) is delegated to the
     * CampaignV2 constructor; if validation fails the whole call
     * reverts and msg.value is returned to the caller.
     *
     * @param title                   Campaign title.
     * @param description             Campaign description.
     * @param goal                    Funding goal in wei (must be > 0).
     * @param deadline                Unix timestamp after which no new
     *                                investments are accepted (must be
     *                                in the future).
     * @param tokenName               ERC-20 name for the governance token.
     * @param tokenSymbol             ERC-20 symbol for the governance token.
     * @param milestoneDescriptions   Human-readable description per milestone.
     * @param milestoneBps            Funding basis points per milestone.
     *                                Each value > 0; all must sum to 10 000.
     *
     * @return campaignAddress  Address of the newly deployed CampaignV2.
     */
    function createCampaign(
        string   memory title,
        string   memory description,
        uint256         goal,
        uint256         deadline,
        string   memory tokenName,
        string   memory tokenSymbol,
        string[] memory milestoneDescriptions,
        uint256[] memory milestoneBps
    ) external payable returns (address campaignAddress) {
        // Deploy CampaignV2 forwarding msg.value as the founder stake.
        // The constructor is payable and records msg.value as founderStake.
        CampaignV2 campaign = new CampaignV2{value: msg.value}(
            msg.sender,   // _founder  — caller owns this campaign
            oracle,       // _oracle   — shared AI agent oracle
            title,
            description,
            goal,
            deadline,
            tokenName,
            tokenSymbol,
            milestoneDescriptions,
            milestoneBps
        );

        campaignAddress = address(campaign);

        // Register in the factory's append-only registry.
        campaigns.push(CampaignInfo({
            campaignAddress: campaignAddress,
            founder:         msg.sender,
            title:           title,
            goal:            goal,
            createdAt:       block.timestamp
        }));

        emit CampaignCreated(campaignAddress, msg.sender, title, goal);
    }

    // ─────────────────────────────────────────────────────────────
    // VIEW FUNCTIONS
    // ─────────────────────────────────────────────────────────────

    /**
     * @notice Return every CampaignInfo record in creation order.
     * @return Array of all campaigns registered in this factory.
     */
    function getCampaigns() external view returns (CampaignInfo[] memory) {
        return campaigns;
    }

    /**
     * @notice Return the total number of campaigns deployed through
     * this factory.
     */
    function getCampaignCount() external view returns (uint256) {
        return campaigns.length;
    }
}
