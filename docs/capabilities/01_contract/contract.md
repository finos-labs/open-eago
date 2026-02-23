# Contract Agent - Universal Task Processing & OASF Enrichment

Category: Core Agent - Utility

## Overview

The Contract Agent accepts **any task** in structured or natural language format, validates input, reviews security and compliance details, detects task type, determines workflow patterns, and enriches to OASF-compliant contracts. It acts as the universal entry point for all task types in the EMCP system.

## OpenEMCP Protocol Integration

The Contract Agent implements **Phase 1 (Contract Management)** of the six-phase OpenEMCP architecture:

1. **Contract Management** ← **Contract Agent (This Component)**
2. Planning & Negotiation ← Enriched contracts sent to Planner Agent
3. Validation (Evaluation) ← Plan review and approval
4. Execution ← Orchestrated multi-agent workflow
5. Context Management ← Hierarchical state preservation
6. Communication ← Secure message exchange and audit

**Architecture Flow**:
```
External Request → Contract Agent → [Phase 1 Complete] → Planning Agent → [Phases 2-6] → Response
```

**Security Integration**: 
- Implements Level 2 authentication (User/Application-to-Framework)
- Validates SPIRE/SPIFFE certificates and mTLS connections
- Enforces OpenEMCP security policies before contract enrichment

**Context Integration**:
- Initializes Session Context with global identifiers
- Creates Conversation Context for topic-specific workflows  
- Prepares hierarchical context structure for downstream phases

**Universal Processing**:
1. **Accept Any Input** - Structured JSON, API calls, or natural language text
2. **Parse & Validate** - Extract entities and validate input quality
3. **Security & Compliance** - Review security context and compliance requirements
4. **Detect Task Type** - Identify workflow category and recommend execution pattern
5. **Enrich to OASF** - Generate compliant contract structure / context
6. **Route to Planner** - Send enriched contract for planning

## Universal Input Acceptance

### Structured API Input (Any Task Type)

```json
{
  "request": {
    // Universal Task Fields
    "objective": "string (required)", // what needs to be accomplished
    "task_data": {}, // flexible object - any business data relevant to task (more details > better task detection)
    
    // Source Context (always required)
    "source_context": {
      "application_id": "string (required)", // identifier for the source application
      "user_id": "string (required)",
      "group_id": ["array (required) - user groups or roles"],
      "session_id": "string (optional)", // session identifier if applicable (e.g., continue, rollback to a step)
      "auth_token": "string (required)", // with authentication details e.g., user_id, group/role
      // Authentication Metadata (POST-mTLS verification)
      "authenticated_identity": {
        "spiffe_id": "spiffe://emcp.example.com/workload/crm-service",
        "certificate_subject": "CN=EXAMPLE-CRM-Service,OU=Example-Systems,O=EXAMPLE",
        "certificate_serial": "4A:B2:C8:D9:E1:F7:33:44",
        "authentication_method": "mtls_spiffe", 
        "authenticated_at": "2026-02-06T10:30:14.123Z",
        "certificate_expires": "2026-02-08T10:30:14.000Z"  // 48h TTL
      }
    },
    
    // Optional Constraints
    "constraints": {
      "max_time": "number (optional)", // maximum time allowed for task execution
      "max_cost": "number (optional)", // maximum budget for task execution converted to ACU (Assumed Cost Unit)
      "retry_policy": "string (optional)", // e.g., "fixed_retry"
      "data_sensitivity": "string (optional)", // e.g., public, internal, confidential, restricted
      "data_classification": "string (optional)", // e.g., PII, PHI, financial, intellectual_property
      "data_integrity": "string (optional)", // e.g., checksum, sha256
      "data_encryption": "string (optional)", // e.g., encryption_required, no_encryption
      "data_audit": "string (optional)", // e.g., audit_required, no_audit (for compliance, on blockchain)
      "data_residency": ["array (optional)"] // e.g., EU, US, Asia-Pacific
    },
    
    // Optional Hints (help with task detection)
    "task_hints": {
      "playbook": "string (optional) - prefered playbook",
      "category": "string (optional) - task category: customer, financial, compliance, etc",
      "operations": ["array (optional) - task operations: validate, update, notify, etc"],
      "priority": "string (optional) - task priority: low, medium, high, urgent"
    }
  }
}
```

### Natural Language Input (Any Task)

```json
{
  "nlp_request": {
    "objective": "string (required) - describe the task in natural language",
    "task_data": {"text": "string (required) - describe what needs to be done"},
    // identical to "request" structure above
    "source_context": {
      "application_id": "string (required)",
      "user_id": "string (required)",
      "group_id": ["array (required)"],
      "session_id": "string (optional)",
      "auth_token": "string (required)",
      // Authentication Metadata (POST-mTLS verification)
      "authenticated_identity": {
        "spiffe_id": "spiffe://emcp.example.com/workload/crm-service",
        "certificate_subject": "CN=EXAMPLE-CRM-Service,OU=Example-Systems,O=EXAMPLE",
        "certificate_serial": "4A:B2:C8:D9:E1:F7:33:44",
        "authentication_method": "mtls_spiffe", 
        "authenticated_at": "2026-02-06T10:30:14.123Z",
        "certificate_expires": "2026-02-08T10:30:14.000Z"  // 48h TTL
      }
    },
    "constraints": {
      // same as above
    },
    "task_hints": {
      // same as above
    }
  }
}
```

## Example: Customer Address Update (Structured Input/Output)

**Input Contact Request:**
```json
{
  "request": {
    "objective": "Update customer address and validate identity for regulatory compliance",
    "task_data": {
      "customer_id": "CUST_UK_789012",
      "current_address": {
        "street": "123 Old Street",
        "city": "London", 
        "postal_code": "EC1V 9NR",
        "country": "UK"
      },
      "new_address": {
        "street": "456 New Avenue",
        "city": "Manchester",
        "postal_code": "M1 4BT", 
        "country": "UK"
      },
      "customer_name": "Sarah Johnson",
      "account_number": "GB29NWBK60161331926819",
      "verification_documents": [
        {"type": "passport", "document_id": "GB123456789"},
        {"type": "utility_bill", "date": "2026-01-15"}
      ]
    },
    "source_context": {
      "application_id": "EXAMPLE_CRM_SYSTEM",
      "user_id": "sarah.clerk@example.com", 
      "group_id": ["customer_service", "address_updaters", "uk_operations"],
      "session_id": "sess_20260206_1030_001",
      "authenticated_identity": {
        "spiffe_id": "spiffe://emcp.example.com/workload/crm-service",
        "certificate_subject": "CN=EXAMPLE-CRM-Service,OU=Example-Systems,O=EXAMPLE",
        "certificate_serial": "4A:B2:C8:D9:E1:F7:33:44",
        "authentication_method": "mtls_spiffe", 
        "authenticated_at": "2026-02-06T10:30:14.123Z",
        "certificate_expires": "2026-02-08T10:30:14.000Z"
      }
    },
    "constraints": {
      "max_time": 10,
      "max_cost": 5.0,
      "retry_policy": "fixed_retry",
      "data_sensitivity": "confidential",
      "data_classification": "PII",
      "data_encryption": "encryption_required",
      "data_audit": "audit_required",
      "data_residency": ["UK", "EU"]
    },
    "task_hints": {
      "playbook": "customer_update",
      "category": "customer_management", 
      "operations": ["validate", "update", "notify"],
      "priority": "medium"
    }
  }
}
```

**Contract Output:**
```json
{
  "execution_id": "exec_a7b8c9d2",
  "emcp_contract_request": {
    "record_id": "REC_CONTRACT_F4A8B2",
    "record_type": "contract_request",
    "record_status": "pending",
    "record_metadata": {
      "created_by": "EXAMPLE_CRM_SYSTEM",
      "created_at": "2026-02-06T10:30:15.234Z",
      "version": "1.0.0",
      "source_system": "EXAMPLE_CRM_SYSTEM"
    },
    "emcp_version": "1.0.0",
    "message_type": "contract_request", 
    "contract_id": "CONTRACT_E7D3A1",
    "timestamp": "2026-02-06T10:30:15.234Z",
    "client": {
      "client_id": "EXAMPLE_CRM_SYSTEM",
      "user_id": "sarah.clerk@example.com",
      "session_id": "sess_20260206_1030_001",

      // Enhanced Authentication Context
      "authentication": {
        "method": "mtls_spiffe",
        "spiffe_id": "spiffe://emcp.example.com/workload/crm-service",
        "certificate_serial": "4A:B2:C8:D9:E1:F7:33:44",
        "authenticated_at": "2026-02-06T10:30:14.123Z",
        "security_level": "high",
        "groups": ["customer_service", "address_updaters", "uk_operations"]
      }
    },
    
    // Security Validation Results
    "security_validation": {
      "authentication_valid": true,
      "authorization_valid": true,
      "certificate_status": "valid",
      "security_level": "high",
      "compliance_checks": {
        "spiffe_validation": "passed",
        "certificate_expiry": "valid_48h",
        "ca_trust_chain": "verified",
        "group_authorization": "authorized"
      }
    },
    
    "requirements": {
      "objective": "Update customer address and validate identity for regulatory compliance",
      "deliverables": ["address_validation", "identity_verification", "database_update", "notification_sending"],
      "required_skills": [
        {
          "skill_id": "address_validation",
          "skill_category": "data_validation",
          "domain_category": "customer_management", 
          "proficiency_level": "intermediate"
        },
        {
          "skill_id": "identity_verification",
          "skill_category": "compliance_checking",
          "domain_category": "customer_management",
          "proficiency_level": "advanced"
        },
        {
          "skill_id": "database_update", 
          "skill_category": "data_management",
          "domain_category": "customer_management",
          "proficiency_level": "intermediate"
        },
        {
          "skill_id": "notification_sending",
          "skill_category": "communication",
          "domain_category": "customer_management", 
          "proficiency_level": "beginner"
        }
      ],
      "constraints": {
        "max_time": 10,
        "max_cost": 5.0,
        "retry_policy": "fixed_retry",
        "data_sensitivity": "confidential",
        "data_classification": "PII",
        "data_encryption": "encryption_required", 
        "data_audit": "audit_required",
        "data_residency": ["UK", "EU"]
      }
    },
    "workflow": {
      "execution_mode": "sequential",
      "tasks": [
        {
          "task_id": "TASK_001",
          "skill_required": "address_validation", 
          "skill_category": "data_validation",
          "domain_category": "customer_management",
          "depends_on": [],
          "timeout_sec": 150
        },
        {
          "task_id": "TASK_002",
          "skill_required": "identity_verification",
          "skill_category": "compliance_checking",
          "domain_category": "customer_management", 
          "depends_on": ["TASK_001"],
          "timeout_sec": 150
        },
        {
          "task_id": "TASK_003",
          "skill_required": "database_update",
          "skill_category": "data_management",
          "domain_category": "customer_management",
          "depends_on": ["TASK_002"], 
          "timeout_sec": 150
        },
        {
          "task_id": "TASK_004",
          "skill_required": "notification_sending",
          "skill_category": "communication", 
          "domain_category": "customer_management",
          "depends_on": ["TASK_003"],
          "timeout_sec": 150
        }
      ]
    },
    "regulatory": {
      "frameworks": ["GDPR", "CCPA", "PSD2", "GDPR_Article_6", "CCPA_1798"],
      "lawful_basis": "legitimate_interest",
      "retention_period_days": 2555,
      "data_minimization": true,
      "consent_required": true,
      "right_to_erasure": true,
      "data_subject_rights": ["access", "rectification", "erasure", "portability"],
      "access_logging_required": true,
      "approval_workflow": true,
      "encryption_at_rest": true,
      "encryption_in_transit": true, 
      "key_management_required": true,
      "audit_trail_required": true,
      "immutable_logging": true,
      "blockchain_anchoring": true,
      "cross_border_mechanism": "adequacy_decision",
      "data_localization_check": true,
      "data_subject_consent": "explicit"
    },
    "payload": {
      "customer_id": "CUST_UK_789012",
      "current_address": {
        "street": "123 Old Street",
        "city": "London",
        "postal_code": "EC1V 9NR", 
        "country": "UK"
      },
      "new_address": {
        "street": "456 New Avenue", 
        "city": "Manchester",
        "postal_code": "M1 4BT",
        "country": "UK"
      },
      "customer_name": "Sarah Johnson",
      "account_number": "GB29NWBK60161331926819",
      "verification_documents": [
        {"type": "passport", "document_id": "GB123456789"},
        {"type": "utility_bill", "date": "2026-01-15"}
      ]
    }
  },
  "task_analysis": {
    "detected_type": "customer_management",
    "confidence_score": 0.95,
    "detected_operations": ["validate", "update", "notify"],
    "workflow_pattern": "sequential",
    "estimated_duration_sec": 600,
    "estimated_cost_usd": 4.75,
    "security_level": "high",
    "compliance_flags": ["sensitive_data", "gdpr_compliance", "ccpa_compliance", "encryption_mandatory", "audit_trail_required"]
  }
}
```

## Summary of Input/Output Patterns

### Input Patterns Supported:
1. **Structured API Requests** - Complete JSON with all fields
2. **Natural Language Requests** - Human-readable descriptions with NLP processing
3. **Mixed Formats** - Structured data with natural language objectives
4. **Urgent/Priority Requests** - Time-sensitive with parallel execution patterns

### Output Enrichment Features:
1. **OASF Compliance** - Full record metadata and protocol headers
2. **Task Analysis** - Confidence scoring and pattern detection
3. **Regulatory Mapping** - Automatic compliance framework assignment
4. **Workflow Optimization** - Sequential vs. parallel execution patterns
5. **Security Classification** - Risk-based security level assignment
6. **Skill Decomposition** - Task breakdown into executable agent skills

### Data Flow:
```
Raw Input → Validation → Task Detection → Skill Mapping → Regulatory Analysis → OASF Enrichment → Planning Agent
```

The Contract Agent successfully transforms diverse input formats into standardized, compliant OASF contracts ready for execution by the OpenEMCP planning and orchestration system.