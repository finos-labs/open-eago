"""
abis.py — ABI fragments for all governance contracts.
Port of the inline ABIs in bridge-base.js.
"""

FLOW_AUTH_ABI = [
    {
        "name": "isAuthorized",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "traceId",    "type": "bytes32"},
            {"name": "agentId",    "type": "uint256"},
            {"name": "capability", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    }
]

REPUTATION_GATE_ABI = [
    {
        "name": "meetsThreshold",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId",    "type": "uint256"},
            {"name": "capability", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    }
]

AUTONOMY_BOUNDS_ABI = [
    {
        "name": "isToolEnabled",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "agentId",   "type": "uint256"},
            {"name": "toolHash",  "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "name": "disableTool",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId",   "type": "uint256"},
            {"name": "toolHash",  "type": "bytes32"},
            {"name": "reason",    "type": "string"},
        ],
        "outputs": [],
    },
    {
        "name": "enableTool",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "agentId",   "type": "uint256"},
            {"name": "toolHash",  "type": "bytes32"},
        ],
        "outputs": [],
    },
]

ACTION_PERMIT_ABI = [
    {
        "name": "validateAction",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "flowId",     "type": "bytes32"},
            {"name": "agentId",    "type": "uint256"},
            {"name": "actionType", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    }
]

IDENTITY_REGISTRY_ABI = [
    {
        "name": "getCardHash",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "agentId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bytes32"}],
    }
]

PROMPT_REGISTRY_ABI = [
    {
        "name": "isActive",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "capability",   "type": "bytes32"},
            {"name": "templateHash", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "name": "registerPrompt",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "capability",   "type": "bytes32"},
            {"name": "templateHash", "type": "bytes32"},
            {"name": "metadataUri",  "type": "string"},
        ],
        "outputs": [{"name": "version", "type": "uint256"}],
    },
    {
        "name": "setActiveVersion",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "capability", "type": "bytes32"},
            {"name": "version",    "type": "uint256"},
        ],
        "outputs": [],
    },
]

ONBOARDING_REGISTRY_ABI = [
    {
        "name": "initiateOnboarding",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",    "type": "bytes32"},
            {"name": "initiator", "type": "address"},
        ],
        "outputs": [],
    },
    {
        "name": "phaseBitmask",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "flowId", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "getPhase",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "flowId", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "ALL_REVIEWS_DONE",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "PHASE_ENTITY_SETUP_DONE",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "PHASE_ACCOUNT_SETUP_DONE",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "name": "PhaseCompleted",
        "type": "event",
        "inputs": [
            {"name": "flowId",    "type": "bytes32", "indexed": True},
            {"name": "phase",     "type": "uint8",   "indexed": True},
            {"name": "timestamp", "type": "uint256",  "indexed": False},
        ],
    },
]

AML_ORACLE_ABI = [
    {
        "name": "requestAMLReview",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",        "type": "bytes32"},
            {"name": "bankAgentId",   "type": "uint256"},
            {"name": "clientAgentId", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "name": "requestClientData",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",    "type": "bytes32"},
            {"name": "bankAgentId",  "type": "uint256"},
            {"name": "dataSpecHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "submitRecommendation",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",   "type": "bytes32"},
            {"name": "bankAgentId", "type": "uint256"},
            {"name": "resultHash",  "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "fulfillDataRequest",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",     "type": "bytes32"},
            {"name": "clientAgentId", "type": "uint256"},
            {"name": "dataHash",      "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "AMLReviewRequested",
        "type": "event",
        "inputs": [
            {"name": "requestId",     "type": "bytes32", "indexed": True},
            {"name": "flowId",        "type": "bytes32", "indexed": True},
            {"name": "bankAgentId",   "type": "uint256", "indexed": False},
            {"name": "clientAgentId", "type": "uint256", "indexed": False},
            {"name": "timestamp",     "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "DataFulfilled",
        "type": "event",
        "inputs": [
            {"name": "requestId",        "type": "bytes32", "indexed": True},
            {"name": "flowId",           "type": "bytes32", "indexed": True},
            {"name": "dataHash",         "type": "bytes32", "indexed": False},
            {"name": "submittingAgentId","type": "uint256", "indexed": False},
            {"name": "timestamp",        "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "DataRequested",
        "type": "event",
        "inputs": [
            {"name": "requestId",    "type": "bytes32", "indexed": True},
            {"name": "flowId",       "type": "bytes32", "indexed": True},
            {"name": "dataSpecHash", "type": "bytes32", "indexed": False},
            {"name": "round",        "type": "uint8",   "indexed": False},
            {"name": "timestamp",    "type": "uint256", "indexed": False},
        ],
    },
]

CREDIT_ORACLE_ABI = [
    {
        "name": "requestCreditReview",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",        "type": "bytes32"},
            {"name": "bankAgentId",   "type": "uint256"},
            {"name": "clientAgentId", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "name": "requestClientData",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",    "type": "bytes32"},
            {"name": "bankAgentId",  "type": "uint256"},
            {"name": "dataSpecHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "proposeTerms",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",   "type": "bytes32"},
            {"name": "bankAgentId", "type": "uint256"},
            {"name": "termsHash",   "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "acceptTerms",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",      "type": "bytes32"},
            {"name": "bankAgentId",    "type": "uint256"},
            {"name": "agreedTermsHash","type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "submitRecommendation",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",   "type": "bytes32"},
            {"name": "bankAgentId", "type": "uint256"},
            {"name": "resultHash",  "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "submitCounterProposal",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",     "type": "bytes32"},
            {"name": "clientAgentId", "type": "uint256"},
            {"name": "proposalHash",  "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "fulfillDataRequest",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",     "type": "bytes32"},
            {"name": "clientAgentId", "type": "uint256"},
            {"name": "dataHash",      "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "getRequest",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "requestId", "type": "bytes32"}],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "flowId",          "type": "bytes32"},
                    {"name": "clientAgentId",   "type": "uint256"},
                    {"name": "bankAgentId",     "type": "uint256"},
                    {"name": "status",          "type": "uint8"},
                    {"name": "dataRequestSpec", "type": "bytes32"},
                    {"name": "dataRequestRound","type": "uint8"},
                    {"name": "currentTermsHash","type": "bytes32"},
                    {"name": "negotiationRound","type": "uint8"},
                    {"name": "resultHash",      "type": "bytes32"},
                    {"name": "createdAt",       "type": "uint256"},
                ],
            }
        ],
    },
    {
        "name": "CreditReviewRequested",
        "type": "event",
        "inputs": [
            {"name": "requestId",     "type": "bytes32", "indexed": True},
            {"name": "flowId",        "type": "bytes32", "indexed": True},
            {"name": "bankAgentId",   "type": "uint256", "indexed": False},
            {"name": "clientAgentId", "type": "uint256", "indexed": False},
            {"name": "timestamp",     "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "DataFulfilled",
        "type": "event",
        "inputs": [
            {"name": "requestId",        "type": "bytes32", "indexed": True},
            {"name": "flowId",           "type": "bytes32", "indexed": True},
            {"name": "dataHash",         "type": "bytes32", "indexed": False},
            {"name": "submittingAgentId","type": "uint256", "indexed": False},
            {"name": "timestamp",        "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "CounterProposed",
        "type": "event",
        "inputs": [
            {"name": "requestId",   "type": "bytes32", "indexed": True},
            {"name": "flowId",      "type": "bytes32", "indexed": True},
            {"name": "proposalHash","type": "bytes32", "indexed": False},
            {"name": "agentId",     "type": "uint256", "indexed": False},
            {"name": "timestamp",   "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "TermsProposed",
        "type": "event",
        "inputs": [
            {"name": "requestId", "type": "bytes32", "indexed": True},
            {"name": "flowId",    "type": "bytes32", "indexed": True},
            {"name": "termsHash", "type": "bytes32", "indexed": False},
            {"name": "round",     "type": "uint8",   "indexed": False},
            {"name": "timestamp", "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "DataRequested",
        "type": "event",
        "inputs": [
            {"name": "requestId",    "type": "bytes32", "indexed": True},
            {"name": "flowId",       "type": "bytes32", "indexed": True},
            {"name": "dataSpecHash", "type": "bytes32", "indexed": False},
            {"name": "round",        "type": "uint8",   "indexed": False},
            {"name": "timestamp",    "type": "uint256", "indexed": False},
        ],
    },
]

LEGAL_ORACLE_ABI = [
    {
        "name": "requestLegalReview",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",        "type": "bytes32"},
            {"name": "bankAgentId",   "type": "uint256"},
            {"name": "clientAgentId", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "name": "issueDraft",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",    "type": "bytes32"},
            {"name": "bankAgentId",  "type": "uint256"},
            {"name": "contractHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "submitRecommendation",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",   "type": "bytes32"},
            {"name": "bankAgentId", "type": "uint256"},
            {"name": "finalHash",   "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "submitMarkup",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "requestId",     "type": "bytes32"},
            {"name": "clientAgentId", "type": "uint256"},
            {"name": "markupHash",    "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "LegalReviewRequested",
        "type": "event",
        "inputs": [
            {"name": "requestId",     "type": "bytes32", "indexed": True},
            {"name": "flowId",        "type": "bytes32", "indexed": True},
            {"name": "bankAgentId",   "type": "uint256", "indexed": False},
            {"name": "clientAgentId", "type": "uint256", "indexed": False},
            {"name": "timestamp",     "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "MarkupSubmitted",
        "type": "event",
        "inputs": [
            {"name": "requestId",  "type": "bytes32", "indexed": True},
            {"name": "flowId",     "type": "bytes32", "indexed": True},
            {"name": "markupHash", "type": "bytes32", "indexed": False},
            {"name": "round",      "type": "uint8",   "indexed": False},
            {"name": "agentId",    "type": "uint256", "indexed": False},
            {"name": "timestamp",  "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "DraftIssued",
        "type": "event",
        "inputs": [
            {"name": "requestId",    "type": "bytes32", "indexed": True},
            {"name": "flowId",       "type": "bytes32", "indexed": True},
            {"name": "contractHash", "type": "bytes32", "indexed": False},
            {"name": "round",        "type": "uint8",   "indexed": False},
            {"name": "timestamp",    "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "InHumanReview",
        "type": "event",
        "inputs": [
            {"name": "requestId", "type": "bytes32", "indexed": True},
            {"name": "flowId",    "type": "bytes32", "indexed": True},
            {"name": "round",     "type": "uint8",   "indexed": False},
            {"name": "timestamp", "type": "uint256", "indexed": False},
        ],
    },
]

SETUP_ORACLE_ABI = [
    {
        "name": "setupLegalEntity",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",         "type": "bytes32"},
            {"name": "agentId",        "type": "uint256"},
            {"name": "entitySpecHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "setupAccount",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",          "type": "bytes32"},
            {"name": "agentId",         "type": "uint256"},
            {"name": "accountSpecHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "name": "setupProducts",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "flowId",          "type": "bytes32"},
            {"name": "agentId",         "type": "uint256"},
            {"name": "productSpecHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
]
