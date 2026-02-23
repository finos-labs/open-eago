# OpenEMCP Governance

This document describes the governance structure for the OpenEMCP project under FINOS foundation.

## Project Structure

OpenEMCP is proposed as a FINOS (Fintech Open Source Foundation) project. The governance structure follows FINOS guidelines while accommodating the specific needs of a protocol specification project.

## Roles and Responsibilities

### Technical Steering Committee (TSC)

The Technical Steering Committee provides technical leadership for the project. Responsibilities include:

- Setting technical direction and priorities
- Reviewing and approving specification changes
- Resolving technical disputes
- Ensuring alignment with FINOS and AI Governance standards
- Coordinating with other FINOS & Linux Foundation projects (AI Governance, FDC3, Agentic AI Foundation - AAIF)

TSC membership is open to active contributors who demonstrate sustained commitment to the project.

### Maintainers

Maintainers are responsible for day-to-day project operations:

- Reviewing and merging pull requests
- Triaging issues and feature requests
- Ensuring documentation quality
- Managing releases and versioning
- Enforcing code of conduct

### Contributors

Contributors are individuals who contribute to the project through:

- Specification improvements and clarifications
- Documentation and examples
- Reference implementations
- Conformance test development
- Issue reporting and discussion

### Working Groups

Working groups focus on specific areas of the specification:

- **Core Protocol Working Group** - Responsible for the core protocol specification including message formats, phases, and abstract operations.

(starting later in the project)

- **Security Working Group** - Responsible for security architecture, authentication, authorization, and encryption requirements.
- **Compliance Working Group** - Responsible for regulatory profiles, data governance, and cross-border compliance mechanisms.
- **AI Governance Working Group** - Responsible for AI risk management, human oversight, and alignment with AI regulations.
- **Interoperability Working Group** - Responsible for integration patterns, SDK guidelines, and conformance testing.

## Decision Making

### Consensus-Based Decisions

Most decisions are made through consensus among active participants. Consensus is reached when:

- A proposal is made via GitHub issue or pull request
- Sufficient time is allowed for review and comment (minimum 7 days for significant changes)
- No substantive objections remain unresolved
- At least two maintainers approve the change

### Voting

When consensus cannot be reached, decisions may be made by vote:

- TSC members have voting rights on technical matters
- Simple majority required for most decisions
- Two-thirds majority required for specification-breaking changes
- Voting period is 7 days unless extended

### Specification Changes

Changes to the normative specification require:

1. **Proposal** - GitHub issue describing the change and rationale
2. **Discussion** - Community discussion period (minimum 14 days)
3. **Pull Request** - Detailed specification change with examples
4. **Review** - Review by at least two TSC members
5. **Approval** - Consensus or vote as described above
6. **Release** - Inclusion in next specification version

## Versioning

### Semantic Versioning

OpenEMCP follows semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR** - Breaking changes to the protocol
- **MINOR** - Backward-compatible additions
- **PATCH** - Backward-compatible fixes and clarifications

### Release Process

1. **Release Candidate** - RC version published for community review
2. **Review Period** - Minimum 30 days for major releases
3. **Final Release** - Published after addressing feedback
4. **Announcement** - Communicated via FINOS channels

## Intellectual Property

### Licensing

All contributions are licensed under Apache License 2.0. Contributors must:

- Sign the FINOS Contributor License Agreement (CLA)
- Ensure contributions do not infringe third-party IP
- Clearly mark any content with different licensing

### Patent Policy

OpenEMCP follows the FINOS IP Policy:

- Contributors grant patent licenses for contributions
- Patent claims against the specification are discouraged
- Defensive termination provisions apply

## Code of Conduct

All participants must adhere to the [FINOS Code of Conduct](https://www.finos.org/code-of-conduct) and the project's [Code of Conduct](CODE_OF_CONDUCT.md).

Violations should be reported to the project maintainers or FINOS staff.

## Communication

### Official Channels

- **GitHub** - Issues, pull requests, and discussions
- **FINOS Slack** - Real-time community discussion
- **Mailing List** - Announcements and formal communications
- **TSC Meetings** - Monthly video calls (recorded and published)

### Meeting Schedule

- TSC meetings: First Tuesday of each month, 10:00 AM ET
- Working group meetings: As scheduled by each group
- Community calls: Quarterly, open to all participants

## FINOS Integration

### Project Status

OpenEMCP aims to progress through FINOS project lifecycle:

1. **Incubating** - Initial contribution and community building **< Project is currently in FINOS LABS**
2. **Active** - Mature specification with multiple implementations
3. **Released** - Stable specification with broad adoption

### Related FINOS Projects

OpenEMCP coordinates with:

- **FINOS AI Governance** - AI risk management frameworks
- **FDC3** - Financial desktop interoperability

## Amendment Process

This governance document may be amended by:

1. Proposal via GitHub pull request
2. Discussion period of 14 days
3. TSC approval by two-thirds majority
4. Publication of updated document
