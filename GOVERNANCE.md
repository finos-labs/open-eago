# OpenEMCP Governance

This document defines project governance for OpenEMCP in alignment with standard FINOS project governance practices.

## 1. Scope

OpenEMCP is an open specification and related artifacts for enterprise multi-agent communication and orchestration. This governance covers technical direction, release management, contribution process, and project operations.

## 2. Project Roles

### 2.1 Technical Steering Committee (TSC)

The TSC is the project's primary technical decision-making body.

**Responsibilities**

- Set and maintain technical direction and roadmap priorities.
- Approve normative specification changes and major architectural decisions.
- Oversee release quality, compatibility, and versioning policy.
- Resolve technical disputes not resolved in normal maintainer workflow.
- Coordinate with relevant FINOS and Linux Foundation initiatives.

**Composition and Membership**

- TSC members are active contributors with sustained, material contributions.
- New TSC members are nominated by an existing TSC member and approved by TSC vote.
- Members are expected to participate regularly in meetings and asynchronous reviews.
- Members may step down voluntarily or be removed by a two-thirds TSC vote for prolonged inactivity or conduct concerns.

**Chair**

- The TSC elects a Chair from current TSC members.
- The Chair manages agenda, meeting cadence, and decision records.
- Chair term is 12 months; re-election is allowed.

### 2.2 Maintainers

Maintainers manage day-to-day repository operations.

- Review and merge pull requests.
- Triage issues and label priorities.
- Maintain documentation and release notes.
- Enforce contribution and code of conduct policies.

Maintainers are appointed by TSC vote.

### 2.3 Contributors

Contributors participate through issues, pull requests, documentation, testing, implementations, and design discussions.

### 2.4 Working Groups

The TSC may charter working groups for focused areas (for example: core protocol, security, compliance, interoperability). Each working group reports decisions and recommendations to the TSC.

## 3. Decision-Making and Voting

### 3.1 Default: Lazy Consensus

The project operates by lazy consensus whenever possible:

- Proposals are made in GitHub issues or pull requests.
- Significant changes should remain open for review for at least 7 days.
- If no unresolved substantive objections remain, maintainers may merge.

### 3.2 TSC Voting Rules

When consensus is not reached, the TSC votes.

- **Quorum:** More than 50% of current TSC members.
- **Simple majority:** Default for routine decisions.
- **Two-thirds majority:** Required for governance changes, breaking normative spec changes, and TSC member removal.
- **Voting window:** 7 calendar days by default unless extended by Chair announcement.
- **Abstentions:** Count toward quorum, not toward yes/no totals.

### 3.3 Appeals

Maintainer decisions may be appealed to the TSC by opening a documented issue. The TSC decision is final for project technical governance.

## 4. Releases and Versioning

- OpenEMCP uses Semantic Versioning (`MAJOR.MINOR.PATCH`).
- Breaking normative protocol changes require explicit migration guidance.
- Release candidates may be published for community review before final release.

## 5. Intellectual Property, Licensing, and Compliance

- Project source and documentation are licensed under Apache-2.0 unless otherwise noted.
- All contributors must comply with FINOS contribution requirements, including applicable CLA/DCO process.
- Contributions must be original or properly licensed and must not knowingly infringe third-party rights.
- The project follows FINOS IP policy and applicable patent commitments.

## 6. Conduct and Community Standards

- All participants must follow the FINOS Code of Conduct and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Reports of misconduct may be sent to maintainers and/or FINOS staff through standard FINOS reporting channels.

## 7. Meetings and Transparency

- TSC meetings are held regularly (target: monthly) and are open to observers when practical.
- Agendas, notes, and decision outcomes are recorded in project channels.
- Major governance and technical decisions are documented in the repository.

## 8. Changes to This Governance

Changes to this document require:

1. A pull request with rationale.
2. At least 14 days of public review.
3. TSC approval by two-thirds majority.

Adopted changes take effect upon merge.
