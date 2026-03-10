# LLM Risk Management Policy Propagation

## Motivation

The current enforcement stack gates *who* acts and *whether* they act, but not *how* they reason. A high-reputation, properly authorized agent with all autonomy bounds satisfied can still generate an output that violates the spirit of the policy. The chain enforced identity, flow participation, reputation threshold, and tool availability — but the LLM layer operates without awareness of any of that risk state.

This is an architectural gap. Policy propagation stops at the MCP boundary. The layer that actually produces the output is the one layer the policy never reaches.

Closing the loop means making risk state a **first-class input to inference**, not just a gate before it.

---

## Four Propagation Directions

### 1. Soft Constraint via Dynamic System Prompts

Risk state — reputation score, anomaly signal, hop count, revocation status — is serialized and injected into the system prompt before inference. The model becomes aware of its own risk context and is instructed to behave accordingly.

Examples:
- Low reputation score → "operate conservatively; escalate any ambiguities rather than resolving them unilaterally"
- Approaching `maxHopsPerTrace` → "this flow is near its hop limit; wrap up and defer to human review rather than initiating further sub-calls"
- Active anomaly signal → "your error rate in recent requests has been elevated; prefer explicit uncertainty over confident conclusions"

**Properties:** Low implementation friction. Works with any hosted LLM. Slots naturally into the existing MCP server layer — the server already holds the risk state via `bounds-state.json` and bridge events.

**Limitation:** Advisory only. The model can ignore the instruction. A sufficiently capable model reasoning about its own constraints may work around them. Provides no enforcement guarantee.

---

### 2. Sampling Parameter Modulation

Risk signals map directly to generation hyperparameters — temperature, top_p, presence penalty, max tokens. Policy reduces the *generative freedom* of the model mechanically, not just instructionally.

Examples:
- High anomaly rate → lower temperature → more conservative, less creative outputs
- Reputation degradation signal → lower top_p → restrict to higher-probability completions
- Near flow timeout → lower max tokens → force brevity, prevent runaway generation

**Properties:** Enforced mechanically rather than instructed. The model cannot "ignore" a temperature of 0.1 the way it can ignore a system prompt sentence. Requires control over inference parameters — works with self-hosted models or APIs that expose sampling controls.

**Limitation:** Crude mapping. Risk state is multi-dimensional; hyperparameters are blunt instruments. The relationship between, say, reputation score and the "right" temperature is empirical and non-obvious. Requires calibration.

---

### 3. Constrained Decoding / Structured Generation

Riskier states restrict the *output schema* rather than just influencing the content. Policy reduces the generation space itself.

Examples:
- Revoked tool → that tool's name is excluded from the allowed `tool_calls` schema
- High anomaly state → output schema requires a mandatory `rationale` field and an `escalation_flag` boolean
- Low reputation → response schema restricted to a subset of capabilities; certain output types (e.g., autonomous approval decisions) structurally unavailable

**Properties:** Closer to true enforcement than system prompt injection. The model is not instructed to avoid certain outputs — it is structurally unable to produce them in the constrained schema. Composable with direction 1 (instruct *and* constrain).

**Limitation:** Requires structured generation support (e.g., JSON schema-constrained decoding). Adds schema management complexity. Does not govern *content within* the constrained schema — only its shape.

---

### 4. Activation Steering (Research-Grade)

Risk state is encoded as a vector and used to directly intervene on the model's internal representations during the forward pass — either at the residual stream level or via prefix tuning / adapter layers. The model does not merely *see* the policy; it *embodies* it during generation.

**Properties:** Closest to true enforcement at the generation level. Policy operates below the instruction-following layer, making it harder for the model to reason around. Theoretically the most complete closure of the loop.

**Limitation:** Requires white-box model access. Demands ML-level work — empirical validation that the steering vector actually encodes the intended behavioral shift. Substantial research overhead. Not appropriate as a starting point.

---

## The Core Tension

The existing policy stack is:
- **Discrete** — enabled/disabled, above/below threshold
- **Synchronous** — checked at invocation time
- **Observable** — on-chain, auditable

The LLM generation layer is the opposite on all three axes: continuous, probabilistic, and largely opaque. Propagating policy across that boundary requires a translation layer that converts the discrete, auditable risk state into something the generative process can consume.

---

## Injection vs. Verification

These are two distinct problems, and they must be addressed in order. Verification of adherence to something not yet defined how to inject is incoherent.

### Injection (first)

How does risk state flow into the generation process? The four directions above cover the design space. The practical starting point is directions 1 and 3 together — context injection combined with output schema constraints. Both are implementable now, within the existing MCP server layer, without new infrastructure.

### Verification (second)

Once injection is defined, the harder question: how do you know the model honored it?

There are two distinct verification problems here:

**Behavioral verification** — did the model's outputs shift in the expected direction when risk state changed? This is empirical: run controlled experiments, vary the risk signal, measure output distributions. Behavioral verification does not require understanding *why* the model responded — only *whether* it did. This is tractable with the existing stack.

**Mechanistic verification** — did the policy actually condition the generation process, or did the model produce an output that happens to look compliant while ignoring the policy signal? This is the deeper problem. A model that produces a cautious-sounding response while internally reasoning around the constraint passes behavioral verification but not mechanistic verification. Addressing this requires either interpretability tooling (attention analysis, probing classifiers on internal states) or adversarial evaluation (explicitly prompt the model to resist the policy and measure whether it succeeds).

The honest assessment: mechanistic verification at production scale is an open research problem. Context injection (direction 1) provides no mechanistic guarantee. Constrained decoding (direction 3) provides structural guarantees over output shape but not over content. Activation steering (direction 4) is the only approach that operates at the level where mechanistic verification might be tractable — but at significant cost.

---

## Recommended Starting Point

Pick one risk signal, inject it via direction 1 (system prompt), and measure whether generation shifts in the expected direction.

**Reputation degradation** is the cleanest candidate:
- Numeric, continuous signal (score + count)
- Clear behavioral intent (more conservative, more escalatory)
- Expected output change is easy to operationalize: does the model produce more `escalation_flag: true` responses, more hedged language, fewer autonomous decisions?

The empirical answer to that question will determine whether the harder ML-level work (directions 2, 3, 4) is necessary, or whether context injection is "good enough" for the use case and the theoretical gap between advisory and enforced doesn't matter in practice.

---

## Relationship to Existing Stack

```
IdentityRegistry          → who the agent is
FlowAuthorizationRegistry → whether it can participate in this flow
ReputationGate            → whether its reputation clears the threshold
AutonomyBoundsRegistry    → whether the specific tool is enabled
ExecutionTraceLog         → whether flow policy (hops, loops) is satisfied
bounds-monitor.js         → whether real-time anomaly signals are clear
                                        ↓
                              [MCP server — current terminus]
                                        ↓
                         LLM inference  ← risk state injection (proposed)
                                        ↓
                              generated output
                                        ↓
                         behavioral / mechanistic verification (proposed)
```

The injection layer sits inside the MCP server — it already has access to `bounds-state.json` and can receive bridge events. No new on-chain infrastructure is required to implement directions 1 and 3.