# Contract Capability Overview

## Purpose

The Contract capability enables the EMCP framework to accept **any task** in structured or natural language format, validates input, reviews security and compliance details, detects task type, determines workflow patterns, and enriches to OASF-compliant contracts. It acts as the universal entry point for all task types in the EMCP system.

**Universal Processing**:
1. **Accept Any Input** - Structured JSON, API calls, or natural language text
2. **Parse & Validate** - Extract entities and validate input quality
3. **Security & Compliance** - Review security context and compliance requirements
4. **Detect Task Type** - Identify workflow category and recommend execution pattern
5. **Enrich to OASF** - Generate compliant contract structure / context
6. **Route to Planner** - Send enriched contract for planning

## What is a Contract?
A contract is a formal agreement between the client and the EMCP framework that outlines the scope of work, deliverables, timelines, and other essential details. It serves as a binding document that ensures both parties understand their responsibilities and expectations. It establishes a clear framework for collaboration and sets the stage for successful project execution. The contract is the first part of the EMCP Session Context, which is a structured representation of the entire project lifecycle.

## What is a "Client"?

A client in the EMCP context can be:
- **Human users** submitting requests through web interfaces or API/MCP calls
- **Other agents** within the EMCP ecosystem requesting work from specialized capabilities
- **External systems** integrating with EMCP through API/MCP endpoints
- **Automated processes** triggering contract creation based on events or schedules

## Security Verification

The Contract capability implements Level 2 authentication (User/Application-to-Framework) as the critical security gateway for OpenEMCP, validating SPIRE/SPIFFE certificates and mTLS connections before contract processing. All requests undergo comprehensive security validation including certificate authentication, identity mapping to authorized user groups, authorization checks against requested operations, and compliance validation based on data classification. Enhanced security context with SPIFFE identity, certificate details, authentication timestamps, and group authorization is embedded in all OASF contracts, providing audit trail foundation and cryptographic proof of authorized access for regulatory requirements while establishing zero-trust verification throughout the contract lifecycle.

## Core Functionality

### 1. **Universal Input Acceptance**
- **Structured API Input**: JSON format with universal task fields, source context, constraints, and task hints
- **Natural Language Processing**: Free-text descriptions converted to structured format
- **Flexible Task Data**: Accepts any business data structure relevant to task detection
- **Smart Task Detection**: Automatic classification into workflow categories (customer management, financial processing, compliance verification, document processing, data analysis)

### 2. **Enhanced Task Type Detection**
- **AI-Powered Classification**: Uses objective text, task data patterns, and optional hints
- **Confidence Scoring**: Returns confidence scores for task type matches
- **Hint-Based Enhancement**: Leverages task hints for higher accuracy classification
- **Pattern Matching**: Analyzes keywords, data structures, and operations for classification

### 3. **Workflow Pattern Analysis**
- **Sequential Processing**: Tasks completed in dependency order for validation/compliance workflows
- **Parallel Processing**: Independent tasks run simultaneously for time-critical operations
- **Hybrid Processing**: Mixed sequential and parallel stages for complex workflows
- **Constraint-Based Optimization**: Considers time limits, priorities, and task complexity

### 4. **OASF Compliance & Enrichment**
- **Skill Mapping**: Maps tasks to OASF skill categories and domain expertise
- **Contract Generation**: Creates full OASF-compliant contract structures
- **Regulatory Integration**: Applies appropriate compliance requirements based on task type
- **Metadata Enhancement**: Enriches with execution metadata and analysis

### 5. **Playbook Integration**
Pre-configured workflows for common business scenarios that provide specialized processing patterns, skill requirements, and compliance frameworks:

#### **Playbook Examples**

**KYC Onboarding (`kyc_onboarding`)**
- **Purpose**: Complete customer identity verification and compliance screening
- **Workflow Pattern**: Sequential (compliance-driven)
- **Required Skills**: 
  - `identity_verification` (Advanced)
  - `document_verification` (Advanced) 
  - `sanctions_screening` (Expert)
  - `regulatory_compliance` (Expert)
- **Process Flow**:
  1. Document collection and validation
  2. Identity verification against authoritative sources
  3. Sanctions and watchlist screening
  4. Jurisdiction-specific compliance checks
  5. Risk scoring and decisioning
  6. Audit trail generation
- **Compliance Requirements**: GDPR, KYC/AML regulations, data residency
- **Estimated Duration**: 5-15 minutes
- **Data Requirements**: Personal identification documents, address verification, beneficial ownership details

**Payment Processing (`payment_processing`)**
- **Purpose**: Secure financial transaction processing with fraud detection
- **Workflow Pattern**: Sequential with parallel fraud checks
- **Required Skills**:
  - `transaction_processing` (Expert)
  - `fraud_detection` (Advanced)
  - `settlement` (Advanced)
  - `risk_assessment` (Intermediate)
- **Process Flow**:
  1. Transaction validation and formatting
  2. Parallel fraud scoring and risk assessment
  3. Regulatory screening (sanctions, limits)
  4. Payment routing and processing
  5. Settlement and reconciliation
  6. Transaction reporting
- **Compliance Requirements**: PCI-DSS, AML/CTF, payment regulations
- **Estimated Duration**: 30 seconds - 5 minutes
- **Data Requirements**: Payment details, account information, merchant data

**Customer Update (`customer_update`)**
- **Purpose**: Customer data modification with validation and notifications
- **Workflow Pattern**: Sequential with parallel notifications
- **Required Skills**:
  - `data_validation` (Intermediate)
  - `database_update` (Advanced)
  - `notification_sending` (Intermediate)
  - `audit_logging` (Intermediate)
- **Process Flow**:
  1. Input validation and data quality checks
  2. Duplicate detection and merge analysis
  3. Database update with version control
  4. Parallel notification dispatch (email, SMS, app)
  5. Audit trail creation
  6. Integration synchronization
- **Compliance Requirements**: GDPR consent, data accuracy obligations
- **Estimated Duration**: 1-3 minutes
- **Data Requirements**: Customer identifiers, updated data fields, notification preferences

**Compliance Audit (`compliance_audit`)**
- **Purpose**: Regulatory compliance verification and reporting
- **Workflow Pattern**: Sequential with comprehensive validation
- **Required Skills**:
  - `regulatory_compliance` (Expert)
  - `audit_reporting` (Advanced)
  - `risk_calculation` (Advanced)
  - `compliance_logging` (Intermediate)
- **Process Flow**:
  1. Scope definition and data collection
  2. Regulatory framework mapping
  3. Compliance rule validation
  4. Gap analysis and risk scoring
  5. Remediation recommendations
  6. Audit report generation
- **Compliance Requirements**: Industry-specific regulations, audit standards
- **Estimated Duration**: 10-30 minutes
- **Data Requirements**: Business processes, transaction data, policy documentation

**Document Analysis (`document_analysis`)**
- **Purpose**: Multi-document processing and data extraction
- **Workflow Pattern**: Parallel document processing with sequential analysis
- **Required Skills**:
  - `text_extraction` (Advanced)
  - `ocr_processing` (Advanced)
  - `entity_extraction` (Intermediate)
  - `content_classification` (Intermediate)
- **Process Flow**:
  1. Document format detection and conversion
  2. Parallel OCR and text extraction
  3. Entity recognition and data parsing
  4. Content classification and validation
  5. Data consolidation and normalization
  6. Quality scoring and confidence assessment
- **Compliance Requirements**: Data protection, document retention policies
- **Estimated Duration**: 2-10 minutes per document
- **Data Requirements**: Document files (PDF, DOCX), processing parameters

#### **Playbook Selection Logic**

```python
def select_optimal_playbook(task_type: str, objective: str, task_data: Dict[str, Any], task_hints: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Select the most appropriate playbook based on task characteristics."""
    
    # Direct playbook hint (highest priority)
    if task_hints and task_hints.get('playbook'):
        return task_hints['playbook']
    
    # Pattern-based selection
    playbook_patterns = {
        "kyc_onboarding": {
            "keywords": ["kyc", "onboarding", "identity", "verification", "customer verification", "due diligence"],
            "data_patterns": ["identity_document", "address_proof", "personal_details", "beneficial_owner"],
            "task_types": ["compliance_verification", "customer_management"]
        },
        "payment_processing": {
            "keywords": ["payment", "transaction", "transfer", "settlement", "fund", "money"],
            "data_patterns": ["amount", "currency", "account_number", "routing", "transaction_id"],
            "task_types": ["financial_processing"]
        },
        "customer_update": {
            "keywords": ["update", "modify", "change", "customer", "profile", "information"],
            "data_patterns": ["customer_id", "address", "contact", "preferences", "profile"],
            "task_types": ["customer_management"]
        },
        "compliance_audit": {
            "keywords": ["audit", "compliance", "review", "regulatory", "assessment", "verification"],
            "data_patterns": ["audit_criteria", "compliance_rules", "regulations", "policies"],
            "task_types": ["compliance_verification"]
        },
        "document_analysis": {
            "keywords": ["document", "extract", "analyze", "parse", "ocr", "text", "pdf"],
            "data_patterns": ["document_url", "file_path", "document_type", "extraction_rules"],
            "task_types": ["document_processing"]
        }
    }
    
    best_match = None
    best_score = 0.0
    
    for playbook, patterns in playbook_patterns.items():
        score = 0.0
        
        # Task type matching (40% weight)
        if task_type in patterns["task_types"]:
            score += 0.4
        
        # Keyword matching in objective (35% weight)
        objective_lower = objective.lower()
        keyword_matches = sum(1 for keyword in patterns["keywords"] if keyword in objective_lower)
        score += (keyword_matches / len(patterns["keywords"])) * 0.35
        
        # Data pattern matching (25% weight)
        data_keys = [key.lower() for key in task_data.keys()]
        pattern_matches = sum(1 for pattern in patterns["data_patterns"] 
                            if any(pattern.lower() in key for key in data_keys))
        score += (pattern_matches / len(patterns["data_patterns"])) * 0.25
        
        if score > best_score and score >= 0.6:  # Minimum confidence threshold
            best_match = playbook
            best_score = score
    
    return best_match
```

#### **Playbook Integration Benefits**

1. **Standardized Workflows**: Consistent processing patterns for common business scenarios
2. **Optimized Performance**: Pre-configured skill requirements and execution patterns
3. **Enhanced Compliance**: Built-in regulatory requirements and audit trails
4. **Faster Processing**: Reduced setup time with proven workflow templates
5. **Quality Assurance**: Validated processes with defined success criteria
6. **Cost Optimization**: Efficient resource allocation based on proven patterns

## Components

### [Contract](contract.md)
**Purpose**: Universal Task Processing & OASF Enrichment  
**Input**: Any structured or natural language task request  
**Output**: Validated OASF Contract with task analysis  
**Key Features**:
- Universal input acceptance (structured JSON or natural language)
- AI-powered task type detection and classification
- Dynamic workflow pattern analysis (sequential/parallel/hybrid)
- OASF compliance enrichment with skill mapping
- Advanced playbook integration for common business scenarios
- Confidence scoring with intelligent processing decisions

## Integration with Planner

The Contract Agent sends enriched contracts to the Planner Agent with:
- **Full OASF Compliance** - All required fields populated
- **Task Analysis** - Type detection, confidence scores, estimates
- **Workflow Recommendations** - Execution patterns and skill requirements
- **Playbook Integration** - Pre-configured workflows when applicable
- **Original Context** - Preserved source application context

This enables the Planner to focus on **execution strategy** rather than input parsing and validation.