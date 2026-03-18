// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IReputationGate.sol";
import "./IReputationRegistry.sol";

/**
 * @title ReputationGate
 * @notice Per-capability reputation threshold gate for ERC-8004 agent workflows.
 *
 * Oracle contracts call meetsThreshold() at fulfillment time to ensure that an
 * agent has earned sufficient positive reputation — as scored by a configured set
 * of trusted evaluators — before its fulfillment is accepted on-chain.
 *
 * Authorization stack position (third layer):
 *   1. onlyRegisteredOracle   — identity: correct wallet + oracle binding
 *   2. FlowAuthorizationRegistry — flow participation: agent allowed in this flow
 *   3. ReputationGate (this)  — quality bar: agent meets score and count thresholds
 *
 * Opt-in enforcement:
 *   - If no threshold is configured for a capability → meetsThreshold returns true.
 *   - If no evaluators are configured → meetsThreshold returns true.
 *   Both conditions must be set for the gate to have any effect.
 *
 * Immutability: thresholds and evaluators CAN be updated (unlike FlowAuthorizationRegistry
 * policies). The owner adjusts them as the agent population matures.
 */
contract ReputationGate is IReputationGate {

    // ── Types ────────────────────────────────────────────────────────────────────

    struct Threshold {
        int128  minScore;          // Minimum acceptable average score
        uint8   scoreDecimals;     // Decimal precision of minScore (0–18)
        uint64  minCount;          // Minimum number of matching feedback entries
        string  tag;               // tag1 filter passed to getSummary (empty = any tag)
        bool    exists;
    }

    // ── Storage ──────────────────────────────────────────────────────────────────

    address public owner;
    IReputationRegistry public reputationRegistry;

    /// capability → threshold configuration
    mapping(bytes32 => Threshold) private _thresholds;

    /// Ordered list of trusted evaluator addresses
    address[] private _evaluators;

    /// Fast membership check for evaluator list
    mapping(address => bool) private _evaluatorSet;

    // ── Events ───────────────────────────────────────────────────────────────────

    event ThresholdSet(
        bytes32 indexed capability,
        int128  minScore,
        uint8   scoreDecimals,
        uint64  minCount,
        string  tag
    );

    event ThresholdRemoved(bytes32 indexed capability);

    event EvaluatorAdded(address indexed evaluator);
    event EvaluatorRemoved(address indexed evaluator);

    // ── Constructor ──────────────────────────────────────────────────────────────

    constructor(address reputationRegistry_) {
        require(reputationRegistry_ != address(0), "zero reputation registry");
        owner = msg.sender;
        reputationRegistry = IReputationRegistry(reputationRegistry_);
    }

    // ── Modifiers ────────────────────────────────────────────────────────────────

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    // ── Configuration — thresholds ────────────────────────────────────────────

    /**
     * @notice Set or update the reputation threshold for a capability.
     *
     * @param capability    keccak256 of the MCP tool name (e.g. keccak256("review_code")).
     * @param minScore      Minimum average score required.
     * @param scoreDecimals Decimal precision of minScore (0–18).
     * @param minCount      Minimum number of matching non-revoked feedback entries.
     * @param tag           tag1 filter for getSummary. Use the capability name string
     *                      (e.g. "review_code") to count only capability-specific feedback,
     *                      or "" to count all feedback from evaluators.
     */
    function setThreshold(
        bytes32 capability,
        int128  minScore,
        uint8   scoreDecimals,
        uint64  minCount,
        string calldata tag
    ) external onlyOwner {
        require(scoreDecimals <= 18, "scoreDecimals > 18");
        _thresholds[capability] = Threshold(minScore, scoreDecimals, minCount, tag, true);
        emit ThresholdSet(capability, minScore, scoreDecimals, minCount, tag);
    }

    /**
     * @notice Remove the threshold for a capability, restoring opt-in behaviour
     *         (meetsThreshold returns true for this capability).
     */
    function removeThreshold(bytes32 capability) external onlyOwner {
        require(_thresholds[capability].exists, "no threshold");
        delete _thresholds[capability];
        emit ThresholdRemoved(capability);
    }

    // ── Configuration — evaluators ────────────────────────────────────────────

    /**
     * @notice Add an address to the trusted evaluator list.
     *         Only feedback from evaluators is counted by meetsThreshold.
     */
    function addEvaluator(address evaluator) external onlyOwner {
        require(evaluator != address(0), "zero evaluator");
        require(!_evaluatorSet[evaluator], "already evaluator");
        _evaluators.push(evaluator);
        _evaluatorSet[evaluator] = true;
        emit EvaluatorAdded(evaluator);
    }

    /**
     * @notice Remove an address from the trusted evaluator list.
     */
    function removeEvaluator(address evaluator) external onlyOwner {
        require(_evaluatorSet[evaluator], "not evaluator");
        _evaluatorSet[evaluator] = false;
        // Swap-and-pop to keep array compact
        uint256 len = _evaluators.length;
        for (uint256 i; i < len; i++) {
            if (_evaluators[i] == evaluator) {
                _evaluators[i] = _evaluators[len - 1];
                _evaluators.pop();
                break;
            }
        }
        emit EvaluatorRemoved(evaluator);
    }

    // ── Core ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Check whether an agent meets the reputation threshold for a capability.
     *
     * Returns true (opt-in) when:
     *   - No threshold is configured for the capability, OR
     *   - No evaluators are configured (cannot call getSummary with empty list).
     *
     * Returns false when:
     *   - The agent has fewer feedback entries than minCount, OR
     *   - The agent's average score is below minScore.
     *
     * Decimal comparison is done by cross-multiplying with int256 to avoid
     * precision loss and overflow:
     *   summaryValue * 10^scoreDecimals  >=  minScore * 10^summaryValueDecimals
     */
    function meetsThreshold(uint256 agentId, bytes32 capability)
        external view override returns (bool)
    {
        Threshold storage t = _thresholds[capability];
        if (!t.exists) return true;                  // no threshold configured → opt-in
        if (_evaluators.length == 0) return true;    // no evaluators → cannot score

        (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) =
            reputationRegistry.getSummary(agentId, _evaluators, t.tag, "");

        if (count < t.minCount) return false;

        // Cross-multiply to compare values with potentially different decimal precisions.
        // int256 is safe: int128 max ~1.7e38, 10^18 = 1e18, product < int256 max ~5.8e76.
        int256 normalizedActual = int256(summaryValue)  * int256(10 ** uint256(t.scoreDecimals));
        int256 normalizedMin    = int256(t.minScore)    * int256(10 ** uint256(summaryValueDecimals));
        return normalizedActual >= normalizedMin;
    }

    // ── Views ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the threshold configuration for a capability.
     */
    function getThreshold(bytes32 capability)
        external view
        returns (int128 minScore, uint8 scoreDecimals, uint64 minCount, string memory tag, bool exists)
    {
        Threshold storage t = _thresholds[capability];
        return (t.minScore, t.scoreDecimals, t.minCount, t.tag, t.exists);
    }

    /**
     * @notice Returns true if a threshold is configured for the capability.
     */
    function thresholdExists(bytes32 capability) external view returns (bool) {
        return _thresholds[capability].exists;
    }

    /**
     * @notice Returns the full list of trusted evaluator addresses.
     */
    function getEvaluators() external view returns (address[] memory) {
        return _evaluators;
    }
}
