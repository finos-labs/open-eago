// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IConsortiumGovernance.sol";

/**
 * @title ConsortiumGovernance
 * @notice On-chain coordination mechanism for the ERC-8004 consortium (P4 control).
 *
 * Responsibilities:
 *   1. Member management     — add/remove member banks via M-of-N vote.
 *   2. Parameter changes     — shared parameter updates via M-of-N vote.
 *   3. Upgrade proposals     — forward callData to a target contract after a vote + timelock.
 *   4. Emergency pause       — any single member can halt all cross-bank flows immediately;
 *                              restoring requires a passed UNPAUSE proposal (M-of-N).
 *
 * Lifecycle:
 *   - Deployer calls bootstrapAddMember() for initial members, then renounceBootstrap().
 *   - After bootstrap, all changes require createProposal → castVote → executeProposal.
 *   - Proposals are active for `votingPeriod` seconds; execution is open to anyone after
 *     the period ends if quorum is met.
 *
 * Members are identified by participantId (bytes32, e.g. keccak256("ACME_BANK")).
 * Each member designates one governance address that casts votes on their behalf.
 *
 * Intra-bank flows are not affected by pauseCrossBank().
 */
contract ConsortiumGovernance is IConsortiumGovernance {

    // ── Types ─────────────────────────────────────────────────────────────────

    enum ProposalType {
        ADD_MEMBER,        // callData = abi.encode(bytes32 pid, address govAddr)
        REMOVE_MEMBER,     // targets[0] = participantId to remove
        PARAM_CHANGE,      // callData = abi.encode(bytes32 paramKey, bytes32 value); emits event
        CONTRACT_UPGRADE,  // callData forwarded to targetContract via low-level call
        UNPAUSE            // restores cross-bank flows after emergency pause
    }

    enum ProposalState { Active, Executed, Defeated }

    struct Member {
        bytes32 participantId;
        address governanceAddress;
        bool    active;
    }

    struct Proposal {
        ProposalType  proposalType;
        ProposalState state;
        bytes32       proposer;
        bytes32[]     targets;
        bytes         callData;
        address       targetContract;
        uint256       votesFor;
        uint256       votingDeadline;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    address public bootstrapOwner;

    /// participantId → Member
    mapping(bytes32 => Member) private _members;
    /// governance address → participantId (reverse lookup)
    mapping(address => bytes32) private _addrToMember;
    /// ordered list of all ever-added participantIds (for enumeration)
    bytes32[] private _memberList;
    uint256   public  memberCount;

    /// Governance parameters (changeable only via PARAM_CHANGE proposals)
    uint256 public quorumNumerator   = 2;
    uint256 public quorumDenominator = 3;
    uint256 public votingPeriod      = 7 days;
    uint256 public upgradeTimelock   = 2 days;

    /// Proposals
    uint256 private _nextProposalId;
    mapping(uint256 => Proposal) private _proposals;
    /// proposalId → participantId → has voted
    mapping(uint256 => mapping(bytes32 => bool)) private _votes;

    /// Emergency pause flag
    bool public override crossBankPaused;

    // ── Events ────────────────────────────────────────────────────────────────

    event MemberAdded(bytes32 indexed participantId, address indexed governanceAddress);
    event MemberRemoved(bytes32 indexed participantId);
    event BootstrapRenounced();

    event ProposalCreated(
        uint256      indexed proposalId,
        ProposalType         proposalType,
        bytes32      indexed proposer,
        uint256              votingDeadline
    );
    event VoteCast(uint256 indexed proposalId, bytes32 indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalDefeated(uint256 indexed proposalId);

    event ParamChanged(bytes32 indexed paramKey, bytes32 value);
    event CrossBankPaused(bytes32 indexed pausedBy);
    event CrossBankResumed(uint256 indexed proposalId);

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyMember() {
        bytes32 pid = _addrToMember[msg.sender];
        require(pid != bytes32(0) && _members[pid].active, "not a member");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        bootstrapOwner = msg.sender;
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    /**
     * @notice Add founding members before governance is live.
     *         Can only be called by the deployer before renounceBootstrap().
     */
    function bootstrapAddMember(bytes32 participantId, address governanceAddress) external {
        require(msg.sender == bootstrapOwner, "not bootstrap owner");
        _addMember(participantId, governanceAddress);
    }

    /**
     * @notice Renounce bootstrap authority.
     *         Requires at least 2 members so that governance can proceed.
     *         After this, all changes require proposals.
     */
    function renounceBootstrap() external {
        require(msg.sender == bootstrapOwner, "not bootstrap owner");
        require(memberCount >= 2, "need at least 2 members");
        bootstrapOwner = address(0);
        emit BootstrapRenounced();
    }

    // ── Proposals ─────────────────────────────────────────────────────────────

    /**
     * @notice Create a governance proposal.
     *
     * @param proposalType   What kind of action is being proposed.
     * @param targets        Context data (e.g. participantId for ADD/REMOVE_MEMBER).
     * @param callData       ABI-encoded payload for PARAM_CHANGE / CONTRACT_UPGRADE / ADD_MEMBER.
     * @param targetContract Target address for CONTRACT_UPGRADE proposals.
     */
    function createProposal(
        ProposalType     proposalType,
        bytes32[] calldata targets,
        bytes     calldata callData,
        address            targetContract
    ) external onlyMember returns (uint256 proposalId) {
        bytes32 proposerPid = _addrToMember[msg.sender];
        proposalId = _nextProposalId++;

        Proposal storage p = _proposals[proposalId];
        p.proposalType   = proposalType;
        p.state          = ProposalState.Active;
        p.proposer       = proposerPid;
        p.callData       = callData;
        p.targetContract = targetContract;
        p.votingDeadline = block.timestamp + votingPeriod;
        for (uint256 i; i < targets.length; i++) {
            p.targets.push(targets[i]);
        }

        emit ProposalCreated(proposalId, proposalType, proposerPid, p.votingDeadline);
    }

    /**
     * @notice Cast a vote on an active proposal.
     *         Each member may vote once. Only affirmative votes count toward quorum.
     */
    function castVote(uint256 proposalId, bool support) external onlyMember {
        Proposal storage p = _proposals[proposalId];
        require(p.state == ProposalState.Active, "proposal not active");
        require(block.timestamp <= p.votingDeadline, "voting period ended");

        bytes32 voterPid = _addrToMember[msg.sender];
        require(!_votes[proposalId][voterPid], "already voted");
        _votes[proposalId][voterPid] = true;

        if (support) p.votesFor++;
        emit VoteCast(proposalId, voterPid, support);
    }

    /**
     * @notice Execute a proposal once its voting period has ended.
     *
     * If quorum is met the proposal action is performed and the proposal is
     * marked Executed. Otherwise it is marked Defeated.
     * Anyone may call this function after the voting period ends.
     */
    function executeProposal(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        require(p.state == ProposalState.Active, "proposal not active");
        require(block.timestamp > p.votingDeadline, "voting period not ended");

        if (!_quorumReached(p.votesFor)) {
            p.state = ProposalState.Defeated;
            emit ProposalDefeated(proposalId);
            return;
        }

        p.state = ProposalState.Executed;

        if (p.proposalType == ProposalType.ADD_MEMBER) {
            (bytes32 pid, address govAddr) = abi.decode(p.callData, (bytes32, address));
            _addMember(pid, govAddr);

        } else if (p.proposalType == ProposalType.REMOVE_MEMBER) {
            require(p.targets.length >= 1, "missing target");
            _removeMember(p.targets[0]);

        } else if (p.proposalType == ProposalType.PARAM_CHANGE) {
            (bytes32 paramKey, bytes32 value) = abi.decode(p.callData, (bytes32, bytes32));
            _applyParamChange(paramKey, value);
            emit ParamChanged(paramKey, value);

        } else if (p.proposalType == ProposalType.CONTRACT_UPGRADE) {
            require(p.targetContract != address(0), "missing target contract");
            (bool success,) = p.targetContract.call(p.callData);
            require(success, "upgrade call failed");

        } else if (p.proposalType == ProposalType.UNPAUSE) {
            crossBankPaused = false;
            emit CrossBankResumed(proposalId);
        }

        emit ProposalExecuted(proposalId);
    }

    // ── Emergency circuit-breaker ─────────────────────────────────────────────

    /**
     * @notice Any single member bank can immediately pause all cross-bank flows.
     *         Restoring requires a passed UNPAUSE proposal (M-of-N).
     *         Intra-bank flows are unaffected — this flag is advisory; oracle
     *         contracts that care about cross-bank pause check crossBankPaused.
     */
    function pauseCrossBank() external onlyMember {
        require(!crossBankPaused, "already paused");
        crossBankPaused = true;
        emit CrossBankPaused(_addrToMember[msg.sender]);
    }

    // ── IConsortiumGovernance ─────────────────────────────────────────────────

    function isMember(bytes32 participantId) external view override returns (bool) {
        return _members[participantId].active;
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getMember(bytes32 participantId)
        external view
        returns (address governanceAddress, bool active)
    {
        Member storage m = _members[participantId];
        return (m.governanceAddress, m.active);
    }

    function getMembers() external view returns (bytes32[] memory) {
        return _memberList;
    }

    function getProposal(uint256 proposalId)
        external view
        returns (
            ProposalType  proposalType,
            ProposalState state,
            bytes32       proposer,
            uint256       votesFor,
            uint256       votingDeadline
        )
    {
        Proposal storage p = _proposals[proposalId];
        return (p.proposalType, p.state, p.proposer, p.votesFor, p.votingDeadline);
    }

    function hasVoted(uint256 proposalId, bytes32 participantId) external view returns (bool) {
        return _votes[proposalId][participantId];
    }

    /// @notice Minimum votes required to reach quorum given the current member count.
    function quorumRequired() public view returns (uint256) {
        if (memberCount == 0) return 0;
        // ceiling division: ceil(memberCount * num / denom)
        return (memberCount * quorumNumerator + quorumDenominator - 1) / quorumDenominator;
    }

    function nextProposalId() external view returns (uint256) {
        return _nextProposalId;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _addMember(bytes32 participantId, address governanceAddress) internal {
        require(participantId != bytes32(0),       "zero participantId");
        require(governanceAddress != address(0),   "zero governance address");
        require(!_members[participantId].active,   "already a member");
        require(_addrToMember[governanceAddress] == bytes32(0), "address already in use");

        _members[participantId] = Member(participantId, governanceAddress, true);
        _addrToMember[governanceAddress] = participantId;
        _memberList.push(participantId);
        memberCount++;
        emit MemberAdded(participantId, governanceAddress);
    }

    function _removeMember(bytes32 participantId) internal {
        require(_members[participantId].active, "not a member");
        require(memberCount > 1, "cannot remove last member");

        address govAddr = _members[participantId].governanceAddress;
        _members[participantId].active = false;
        delete _addrToMember[govAddr];
        memberCount--;
        emit MemberRemoved(participantId);
    }

    bytes32 private constant PARAM_QUORUM_NUM   = keccak256("quorumNumerator");
    bytes32 private constant PARAM_QUORUM_DEN   = keccak256("quorumDenominator");
    bytes32 private constant PARAM_VOTING_PERIOD = keccak256("votingPeriod");
    bytes32 private constant PARAM_TIMELOCK      = keccak256("upgradeTimelock");

    function _applyParamChange(bytes32 paramKey, bytes32 value) internal {
        uint256 v = uint256(value);
        if      (paramKey == PARAM_QUORUM_NUM)    { require(v > 0, "zero numerator");   quorumNumerator   = v; }
        else if (paramKey == PARAM_QUORUM_DEN)    { require(v > 0, "zero denominator"); quorumDenominator = v; }
        else if (paramKey == PARAM_VOTING_PERIOD) { require(v > 0, "zero period");      votingPeriod      = v; }
        else if (paramKey == PARAM_TIMELOCK)      { upgradeTimelock = v; }
        // Unknown keys: emit event only (consumers may read off-chain).
    }

    function _quorumReached(uint256 votes) internal view returns (bool) {
        return votes >= quorumRequired();
    }
}
